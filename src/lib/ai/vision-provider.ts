import "server-only";
import { aiEnv } from "@/config/env";
import { FakeVisionProvider } from "@/domains/ai/fake-vision";
import { VisionUnavailableError, type VisionProvider } from "@/domains/ai/vision";
import { AnthropicVisionProvider } from "./anthropic-vision";

/** Misconfiguration surfaces as an analyzer outage (staff still review), not a broken submit. */
class MisconfiguredVision implements VisionProvider {
  readonly name = "unconfigured";
  readonly model = "none";
  constructor(private readonly reason: string) {}
  async analyze(): Promise<unknown> {
    throw new VisionUnavailableError(this.reason);
  }
}

export function visionProvider(): VisionProvider {
  let env;
  try {
    env = aiEnv();
  } catch (err) {
    return new MisconfiguredVision(err instanceof Error ? err.message : String(err));
  }
  const provider = env.AI_VISION_PROVIDER;
  switch (provider) {
    case "anthropic":
      return new AnthropicVisionProvider(env.ANTHROPIC_API_KEY!, env.AI_VISION_MODEL);
    case "fake":
      return new FakeVisionProvider();
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown vision provider: ${String(exhaustive)}`);
    }
  }
}
