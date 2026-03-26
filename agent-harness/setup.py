from setuptools import setup, find_namespace_packages

setup(
    name="cli-anything-meridian",
    version="0.1.0",
    description="CLI harness for the Meridian Solana DLMM LP agent",
    packages=find_namespace_packages(include=["cli_anything.*"]),
    install_requires=[
        "click>=8.0",
    ],
    entry_points={
        "console_scripts": [
            "cli-anything-meridian=cli_anything.meridian.meridian_cli:main",
        ]
    },
    python_requires=">=3.10",
)
