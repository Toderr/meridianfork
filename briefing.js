import { generateReport } from "./reports.js";

export async function generateBriefing() {
  return generateReport("daily");
}
