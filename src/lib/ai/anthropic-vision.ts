import type { VisionProvider, VisionRequest } from "@/domains/ai/vision";
import { VisionUnavailableError } from "@/domains/ai/vision";

const API_URL = "https://api.anthropic.com/v1/messages";
const TOOL_NAME = "record_analysis";

interface ToolUseBlock {
  type: "tool_use";
  name: string;
  input: unknown;
}

/** Claude vision via the Messages API, forced to answer through one tool call (structured JSON). */
export class AnthropicVisionProvider implements VisionProvider {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async analyze(request: VisionRequest): Promise<unknown> {
    const response = await this.fetchImpl(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2000,
        temperature: 0,
        system: request.system,
        tools: [{ name: TOOL_NAME, description: "Record the photo analysis.", input_schema: request.toolSchema }],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [
          {
            role: "user",
            content: [
              ...request.images.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: Buffer.from(image.bytes).toString("base64") },
              })),
              { type: "text", text: request.instructions },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new VisionUnavailableError(`Anthropic API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as { content?: unknown[] };
    const block = body.content?.find(
      (b): b is ToolUseBlock => typeof b === "object" && b !== null && (b as ToolUseBlock).type === "tool_use" && (b as ToolUseBlock).name === TOOL_NAME,
    );
    if (!block) throw new VisionUnavailableError("Anthropic response had no analysis tool call.");
    return block.input;
  }
}
