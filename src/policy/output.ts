import type { TurnContext } from "../types.js";

export interface OutputPolicyResult {
  accepted: boolean;
  output: string;
  issues?: string[];
}

export interface OutputPolicy {
  apply(output: string, context: TurnContext): OutputPolicyResult | Promise<OutputPolicyResult>;
}

export class AcceptAllOutput implements OutputPolicy {
  apply(output: string): OutputPolicyResult {
    return { accepted: true, output };
  }
}

export class MaxLengthOutput implements OutputPolicy {
  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new TypeError("maxCharacters must be a positive integer");
    }
  }

  apply(output: string): OutputPolicyResult {
    return output.length <= this.maxCharacters
      ? { accepted: true, output }
      : { accepted: false, output, issues: [`output exceeds ${this.maxCharacters} characters`] };
  }
}
