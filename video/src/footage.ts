import { staticFile } from "remotion";

/**
 * True if public/raw/<fileName> exists. calculateMetadata runs inside the same headless-Chrome
 * bundle as every component (there is no separate Node phase — `node:fs` cannot be bundled),
 * so existence is probed with a HEAD request against Remotion's static file server instead.
 * Call this only from a Composition's calculateMetadata, which supports async.
 */
export async function footageExists(fileName: string): Promise<boolean> {
  try {
    const response = await fetch(staticFile(`raw/${fileName}`), { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}
