import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  SmallHourRuntime,
  StaticPersonaSource,
  ToolRegistry,
  type MemorySource,
  type ProviderMessage,
} from "../../src/index.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";

const model = process.env.ANTHROPIC_MODEL;
if (!process.env.ANTHROPIC_API_KEY || !model) {
  throw new Error("set ANTHROPIC_API_KEY and ANTHROPIC_MODEL to run this example");
}

const history: ProviderMessage[] = [];
const memory: MemorySource = {
  async load() {
    return history.slice(-8);
  },
};

const tools = new ToolRegistry([
  {
    name: "read_clock",
    description: "Read the current local time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    mode: "read",
    execute: () => ({ localTime: new Date().toLocaleString() }),
  },
]);

const runtime = new SmallHourRuntime({
  provider: new AnthropicProvider({ model }),
  persona: new StaticPersonaSource(
    "You are Moth, a tiny observatory caretaker. Speak briefly and concretely. Use read_clock when time matters.",
  ),
  memory,
  tools,
});

const terminal = createInterface({ input: stdin, output: stdout });
try {
  while (true) {
    const line = (await terminal.question("you> ")).trim();
    if (!line || line === "/quit") break;
    const result = await runtime.turn({ agentId: "moth", input: line, allowedTools: ["read_clock"] });
    if (!result.accepted) {
      console.error(result.issues.join("; "));
      continue;
    }
    console.log(`moth> ${result.output}`);
    history.push({ role: "user", content: line }, { role: "assistant", content: result.output });
  }
} finally {
  terminal.close();
}
