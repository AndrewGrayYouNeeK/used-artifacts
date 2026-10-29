import { describe, expect, it } from "vitest";
import { buildVisionRequest } from "@/domains/ai/vision";
import { AnthropicVisionProvider } from "./anthropic-vision";

const request = buildVisionRequest(
  [{ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/webp" }],
  [{ id: "c1", slug: "bottles", name: "Bottles", isNativeAmerican: false }],
);

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("AnthropicVisionProvider", () => {
  it("forces a single tool call with the images and returns its input", async () => {
    const { impl, calls } = stubFetch(200, {
      content: [
        { type: "text", text: "Here is my analysis" },
        { type: "tool_use", name: "record_analysis", input: { uncertainty: "LOW", observations: [], redFlags: [] } },
      ],
    });
    const provider = new AnthropicVisionProvider("sk-test", "claude-test", impl);
    expect(await provider.analyze(request)).toEqual({ uncertainty: "LOW", observations: [], redFlags: [] });

    const body = JSON.parse(String(calls[0].init.body));
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    expect(body.model).toBe("claude-test");
    expect(body.tool_choice).toEqual({ type: "tool", name: "record_analysis" });
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/webp", data: "AQID" } });
    expect(body.system).toMatch(/never authenticate/i);
  });

  it("reports API errors and missing tool calls as an outage", async () => {
    await expect(new AnthropicVisionProvider("k", "m", stubFetch(529, { error: "overloaded" }).impl).analyze(request)).rejects.toThrow(/529/);
    await expect(
      new AnthropicVisionProvider("k", "m", stubFetch(200, { content: [{ type: "text", text: "no tool" }] }).impl).analyze(request),
    ).rejects.toThrow(/no analysis tool call/);
  });
});
