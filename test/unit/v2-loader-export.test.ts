import { describe, expect, it } from "vitest";

import localPlugin from "../../.opencode/plugins/opencode-smart-router";
import plugin from "../../src/v2/index";

describe("OpenCode V2 loader contract", () => {
  it("exports a definition object with a stable id and setup function", () => {
    expect(typeof plugin).toBe("object");
    expect(plugin.id).toBe("opencode-smart-router");
    expect(typeof plugin.setup).toBe("function");
  });

  it("uses the same definition from the auto-discovered local entrypoint", () => {
    expect(localPlugin).toBe(plugin);
  });
});
