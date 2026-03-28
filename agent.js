import OpenAI from "openai";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

const EXPERIMENT_TOOLS = new Set(["start_experiment", "get_experiment", "list_experiments", "pause_experiment", "resume_experiment", "cancel_experiment"]);
const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "update_config", "get_position_pnl", "get_my_positions", "set_position_note", "add_pool_note", "get_wallet_balance", "withdraw_liquidity", "add_liquidity", "list_strategies", "get_strategy", "set_active_strategy", "get_pool_detail", "get_token_info", "get_active_bin", "study_top_lpers", ...EXPERIMENT_TOOLS]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "add_pool_note", "add_to_blacklist", "update_config", "get_wallet_balance", "get_my_positions", "list_strategies", "get_strategy", "set_active_strategy", "swap_token", "add_liquidity", "study_top_lpers", "get_pool_detail", "get_hive_pulse", "get_hive_pool_consensus", "get_hive_lessons", ...EXPERIMENT_TOOLS]);

function getToolsForRole(agentType) {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));
  return tools;
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";

// OpenRouter uses the OpenAI-compatible API
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000, // 5 min — free models can be slow (20 tok/s)
});

// Model resolved at call time from config, so hot-reload changes take effect immediately

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null) {
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary);

  const messages = [
    { role: "system", content: systemPrompt },
    ...sessionHistory,          // inject prior conversation turns
    { role: "user", content: goal },
  ];

  const MAX_EMPTY_STREAK = 3;
  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = model || config.llm.generalModel;

      // Retry up to 3 times on transient provider errors or empty responses.
      // After 3 failures, fall back to FALLBACK_MODEL for this turn only.
      const FALLBACK_MODEL = "z-ai/glm-5";
      let response;
      let usedModel = activeModel;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType),
            tool_choice: "auto",
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (apiErr) {
          // Network / timeout errors count as a failed attempt
          log("agent", `API error on attempt ${attempt + 1}/3: ${apiErr.message}`);
          response = { choices: null, error: { message: apiErr.message, code: apiErr.status } };
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        const wait = (attempt + 1) * 5000;
        log("agent", `No response (${errCode || "empty"}), retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, wait));
      }

      // If primary model failed 3 times, try fallback model once for this turn
      if (!response.choices?.length && usedModel !== FALLBACK_MODEL) {
        log("agent", `Primary model failed 3 times — falling back to ${FALLBACK_MODEL} for this turn`);
        usedModel = FALLBACK_MODEL;
        try {
          response = await client.chat.completions.create({
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType),
            tool_choice: "auto",
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          });
        } catch (apiErr) {
          log("error", `Fallback model also failed: ${apiErr.message}`);
          response = { choices: null, error: { message: apiErr.message } };
        }
      }

      if (!response.choices?.length) {
        log("error", `All models failed. Last response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      messages.push(msg);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes/XML-format models sometimes return raw <tool_call> XML in content instead of
        // using the proper function calling format. Treat as empty so we retry.
        const isXmlToolCall = msg.content && (
          msg.content.trim().startsWith("<tool_call>") ||
          msg.content.trim() === ">" ||
          /^[\s>]*<\/tool_call>/.test(msg.content.trim())
        );

        if (!msg.content || isXmlToolCall) {
          messages.pop(); // remove the empty/malformed assistant message
          emptyStreak++;
          if (isXmlToolCall) log("agent", `Model output raw XML tool call — model may not support function calling properly`);
          log("agent", `Empty response, retrying... (${emptyStreak}/${MAX_EMPTY_STREAK})`);
          if (emptyStreak >= MAX_EMPTY_STREAK) {
            log("agent", `Empty response streak limit reached — aborting loop`);
            return { content: "Model returned empty responses repeatedly. Try again or switch model.", userMessage: goal };
          }
          continue;
        }
        emptyStreak = 0;
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal };
      }

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name;
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
          functionArgs = {};
        }

        const result = await executeTool(functionName, functionArgs);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
