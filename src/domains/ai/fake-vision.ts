import type { VisionProvider, VisionRequest } from "./vision";
import { VisionUnavailableError } from "./vision";

/**
 * Deterministic stand-in for dev and tests. Production refuses it. Tests set
 * `respond` to return specific (including malicious or malformed) output.
 */
export class FakeVisionProvider implements VisionProvider {
  readonly name = "fake";
  readonly model = "fake-vision-1";
  requests: VisionRequest[] = [];
  fail = false;
  respond: (request: VisionRequest) => unknown = defaultResponse;

  async analyze(request: VisionRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.fail) throw new VisionUnavailableError("Simulated vision outage");
    return this.respond(request);
  }
}

function defaultResponse(request: VisionRequest): unknown {
  const slug = request.instructions.match(/\(([a-z0-9-]+)\)\./)?.[1] ?? null;
  return {
    suggestedCategorySlug: slug,
    identification: { label: "Worked stone point", confidence: 0.55 },
    suggestedTitle: "Worked stone point",
    materials: "Chert or flint",
    estimatedAge: "Age unclear from photos",
    regionOfOrigin: "Eastern North America (unverified)",
    valueRangeUsd: { low: 40, high: 120 },
    observations: [
      `Simulated analysis of ${request.images.length} photo(s); no real model was called.`,
      "Even surface patina; small ding near the tip.",
    ],
    redFlags: [],
    uncertainty: "MEDIUM",
  };
}
