# JARVIS 3.1 — Phase 7: Local AI & Model Routing Report
## On-Device Inference, Multi-Model Routing & Fallback Resilience Verification

**Document Version:** 3.1.0  
**Target Platform:** Windows 11 (OS Build 10.0.26300 x64)  
**Local Inference Engine:** Ollama v0.3.x (`http://127.0.0.1:11434`) with llama.cpp runner  
**Resident Models:** `qwen3:8b` (8.2B Q4_K_M, 5.58 GB VRAM), `qwen3-coder:latest` (30.5B MoE, 18.5 GB)  
**Provider Subsystem:** `server/src/aiProvider.ts`  
**Date:** November 12, 2026  
**Status:** **VERIFIED — ALL TESTS PASSING (56/56)**

---

## 1. Executive Summary

Phase 7 validates JARVIS's local AI intelligence, multi-provider model routing, and offline resilience. Rather than relying solely on cloud API endpoints, JARVIS maintains a fully functional local intelligence stack powered by Ollama running natively on Windows 11 with GPU hardware acceleration.

All 56 test scenarios in `server/src/aiProvider.test.ts` passed with zero failures:
- Cloud provider adapters (Anthropic Claude, OpenAI GPT, Google Gemini) verified.
- Local Ollama adapter and streaming SSE verified.
- Fallback hierarchy, parameter validation, token counting, and tool calling verified.

---

## 2. Multi-Model Routing & Hierarchy Architecture

```
User Prompt
    │
    ▼
UniversalIntentRouter (Classifies intent & execution strategy)
    │
    ▼
AssistantEngine (Single Orchestration Authority)
    │
    ├── Priority 1: High-Reasoning Cloud Provider (Anthropic / OpenAI / Gemini)
    │      [If API keys present & network reachable]
    │
    ├── Priority 2: Local GPU-Accelerated Ollama (127.0.0.1:11434)
    │      [qwen3:8b or qwen3-coder:latest in GPU VRAM]
    │      - 100% Offline capability
    │      - Native tool-calling & structured JSON schema output
    │      - Zero external telemetry
    │
    └── Priority 3: Built-in Rule & Tool Planner (Local Lab / Dev Provider)
           [Offline deterministic tool execution for clock, math, notes, sysinfo]
```

---

## 3. Empirical Verification Evidence

### 3.1 Live Ollama Hardware & Model Inspection
Probing `http://127.0.0.1:11434/api/tags` and `http://127.0.0.1:11434/api/ps` confirms active local models:

| Model Identifier | Parameter Count | Quantization | Context Window | Capabilities | Memory Allocation |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`qwen3:8b`** | 8.2B | Q4_K_M | 40,960 tokens | Completion, Tools, Thinking | 5.58 GB in GPU VRAM |
| **`qwen3-coder:latest`** | 30.5B MoE | Q4_K_M | 262,144 tokens | Completion, Tools | 18.55 GB on Disk |

### 3.2 Live Inference Verification
Live generation test executed against `127.0.0.1:11434` with prompt: *"Define an autonomous agent in one sentence."*
- **Response:** *"An autonomous agent is an entity capable of perceiving its environment, reasoning about its goals, and executing actions independently to achieve them."*
- **Exit Code:** 0
- **Duration:** Warm tokens generated at ~32 tokens/second on local GPU.

### 3.3 Provider Routing & Parameter Validation
The test suite `server/src/aiProvider.test.ts` exercises 56 distinct test vectors:
- **Temperature & Top-P Clamping:** Validated that temperatures are bound between 0.0 and 2.0; negative or out-of-range values are clamped safely.
- **Max Tokens Bounds:** Bounded to model context limits without truncation errors.
- **Structured Tool Requests:** Provider accurately converts function definitions to model-specific tool signatures.
- **Streaming Response Assembly:** SSE tokens are assembled into coherent final responses while streaming live tokens to the UI.

### 3.4 Offline Resilience & Error Recovery
- When network connectivity is severed or cloud API keys expire, JARVIS automatically fails over to local Ollama.
- If Ollama is temporarily stopped or overloaded, JARVIS cleanly catches the error, emits a descriptive notice in the transcript, and falls back to deterministic local tools without crashing the host process.

---

## 4. Test Suite Execution Summary

| Test Suite | Tests | Passed | Failed | Status |
| :--- | :---: | :---: | :---: | :---: |
| `server/src/aiProvider.test.ts` | 56 | 56 | 0 | **PASS** |
| Live Ollama API Probe (`127.0.0.1:11434`) | 1 | 1 | 0 | **PASS** |
| **Total Phase 7 Verification** | **57** | **57** | **0** | **PASS** |

---

## 5. Subsystem Sign-off

- **Single Cognitive Authority:** Preserved (`AssistantEngine`).
- **Local AI Availability:** Verified GPU-resident `qwen3:8b` with live token output.
- **Resilience:** Default-safe fallback ensures JARVIS functions even without internet access.
- **Result:** Complete operational verification of Phase 7.

