import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DefaultPackageManager, SettingsManager, loadSkills } from "@earendil-works/pi-coding-agent";
import { loadProject, saveProject, effectiveEnabled, type ProjectModel, type ResourceRow } from "../src/model.ts";

function put(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-capabilities-"));
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agent, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  put(join(agent, "skills", "fixture-global", "SKILL.md"),
    "---\nname: fixture-global\ndescription: Global fixture\n---\nGlobal instructions");
  put(join(cwd, ".pi", "skills", "fixture-local", "SKILL.md"),
    "---\nname: fixture-local\ndescription: Local fixture\n---\nLocal instructions");
  return { root, agent, cwd };
}
function row(model: ProjectModel, name: string): ResourceRow {
  const result = model.rows.find((item) => item.name === name);
  assert.ok(result, `Missing row: ${name}`);
  return result;
}

async function assertNativeSkill(f: { cwd: string; agent: string }, name: string, expected: boolean) {
  const settingsManager = SettingsManager.create(f.cwd, f.agent, { projectTrusted: true });
  const manager = new DefaultPackageManager({ cwd: f.cwd, agentDir: f.agent, settingsManager });
  const resources = await manager.resolve(async () => "skip");
  const loaded = loadSkills({ cwd: f.cwd, agentDir: f.agent, includeDefaults: false,
    skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path) });
  assert.equal(loaded.skills.some((skill) => skill.name === name), expected, `Native Skill loading: ${name}`);
}

test("global Skill can be disabled, re-enabled and restored without changing global files", async () => {
  const f = fixture();
  const globalPath = join(f.agent, "settings.json");
  put(globalPath, { theme: "dark" });
  const original = readFileSync(globalPath, "utf8");
  let model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-global")), true);
  row(model, "fixture-global").state = "off";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(row(model, "fixture-global").state, "off");
  assert.equal(effectiveEnabled(row(model, "fixture-global")), false);
  await assertNativeSkill(f, "fixture-global", false);
  row(model, "fixture-global").state = "on";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-global")), true);
  await assertNativeSkill(f, "fixture-global", true);
  row(model, "fixture-global").state = "inherit";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(row(model, "fixture-global").state, "inherit");
  assert.equal(effectiveEnabled(row(model, "fixture-global")), true);
  assert.equal(readFileSync(globalPath, "utf8"), original);
  assert.equal(model.settings.data.skills, undefined);
});

test("globally disabled Skill is visible and returns to disabled when inheriting", async () => {
  const f = fixture();
  const path = join(f.agent, "skills", "fixture-global", "SKILL.md");
  put(join(f.agent, "settings.json"), { skills: [`-${path}`] });
  let model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-global")), false);
  row(model, "fixture-global").state = "on";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(row(model, "fixture-global").inheritedEnabled, false);
  row(model, "fixture-global").state = "inherit";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-global")), false);
});

test("package filters and project settings are preserved while overriding a package Skill", async () => {
  const f = fixture();
  const pkg = join(f.root, "fixture-package");
  put(join(pkg, "package.json"), { name: "fixture-package", pi: { skills: ["./skills"] } });
  put(join(pkg, "skills", "fixture-package-skill", "SKILL.md"),
    "---\nname: fixture-package-skill\ndescription: Packaged fixture\n---\nBody");
  const globalPath = join(f.agent, "settings.json");
  put(globalPath, { packages: [{ source: pkg, skills: [] }] });
  put(join(f.cwd, ".pi", "settings.json"), { theme: "light", packages: [pkg] });
  const original = readFileSync(globalPath, "utf8");
  let model = await loadProject(f.cwd, f.agent);
  row(model, "fixture-package-skill").state = "off";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-package-skill")), false);
  await assertNativeSkill(f, "fixture-package-skill", false);
  assert.equal(model.settings.data.theme, "light");
  const projectPackages = model.settings.data.packages as { source: string }[];
  assert.equal(projectPackages[0].source, pkg);
  row(model, "fixture-package-skill").state = "inherit";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-package-skill")), true);
  await assertNativeSkill(f, "fixture-package-skill", true);
  assert.deepEqual(model.settings.data.packages, [pkg]);
  assert.equal(readFileSync(globalPath, "utf8"), original);
});

test("project-only Skill keeps discovery after resetting its override", async () => {
  const f = fixture();
  const path = join(f.root, "outside", "SKILL.md");
  put(path, "---\nname: fixture-outside\ndescription: External project Skill\n---\nBody");
  put(join(f.cwd, ".pi", "settings.json"), { skills: [path] });
  let model = await loadProject(f.cwd, f.agent);
  row(model, "fixture-outside").state = "off";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  row(model, "fixture-outside").state = "inherit";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixture-outside")), true);
});

test("MCP overrides never copy credentials and preserve exposure and project definitions", async () => {
  const f = fixture();
  const globalPath = join(f.agent, "mcp.json");
  put(globalPath, { mcpServers: {
    fixtureDocs: { url: "https://example.invalid/mcp", headers: { Authorization: "secret-marker" } },
    fixtureDisabled: { command: "node", enabled: false },
  } });
  put(join(f.cwd, ".pi", "mcp.json"), { autoEnableCodemode: false, mcpServers: {
    fixtureDocs: { exposure: "deferred" },
    fixtureLocal: { command: "node", args: ["local.js"], enabled: false },
  } });
  const original = readFileSync(globalPath, "utf8");
  let model = await loadProject(f.cwd, f.agent);
  row(model, "fixtureDocs").state = "off";
  row(model, "fixtureDisabled").state = "on";
  row(model, "fixtureLocal").state = "inherit";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.equal(effectiveEnabled(row(model, "fixtureDocs")), false);
  assert.equal(effectiveEnabled(row(model, "fixtureDisabled")), true);
  assert.equal(effectiveEnabled(row(model, "fixtureLocal")), true);
  assert.ok(!readFileSync(model.mcp.path, "utf8").includes("secret-marker"));
  assert.deepEqual(model.mcp.data.mcpServers, {
    fixtureDocs: { exposure: "deferred", enabled: false },
    fixtureDisabled: { enabled: true },
    fixtureLocal: { command: "node", args: ["local.js"] },
  });
  row(model, "fixtureDocs").state = "inherit";
  row(model, "fixtureDisabled").state = "inherit";
  saveProject(model);
  model = await loadProject(f.cwd, f.agent);
  assert.deepEqual((model.mcp.data.mcpServers as Record<string, unknown>).fixtureDocs, { exposure: "deferred" });
  assert.equal(effectiveEnabled(row(model, "fixtureDisabled")), false);
  assert.equal(model.mcp.data.autoEnableCodemode, false);
  assert.equal(readFileSync(globalPath, "utf8"), original);
});

test("concurrent configuration edits are rejected before any writes", async () => {
  const f = fixture();
  put(join(f.agent, "mcp.json"), { mcpServers: { fixtureDocs: { command: "node" } } });
  const model = await loadProject(f.cwd, f.agent);
  row(model, "fixture-global").state = "off";
  row(model, "fixtureDocs").state = "off";
  put(model.mcp.path, { mcpServers: {}, changedElsewhere: true });
  assert.throws(() => saveProject(model), /已被修改/);
  assert.equal(model.settings.text, undefined);
  assert.throws(() => readFileSync(model.settings.path), /ENOENT/);
});

test("a different project retains inherited global state", async () => {
  const f = fixture();
  const other = join(f.root, "other");
  mkdirSync(other);
  const model = await loadProject(f.cwd, f.agent);
  row(model, "fixture-global").state = "off";
  saveProject(model);
  assert.equal(effectiveEnabled(row(await loadProject(other, f.agent), "fixture-global")), true);
});

test("no-op save writes nothing and malformed JSON fails closed", async () => {
  const f = fixture();
  const model = await loadProject(f.cwd, f.agent);
  assert.equal(saveProject(model), false);
  assert.throws(() => readFileSync(model.mcp.path), /ENOENT/);
  put(model.mcp.path, "{ malformed");
  await assert.rejects(loadProject(f.cwd, f.agent), SyntaxError);
});

test("extension-registered MCP is visible and explicitly read-only", async () => {
  const f = fixture();
  const model = await loadProject(f.cwd, f.agent, [{
    name: "fixtureRegistered", config: { command: "node" }, extensionPath: "/extension.ts",
  }]);
  assert.equal(row(model, "fixtureRegistered").editable, false);
});

for (const scope of ["global", "project-empty"] as const) {
  test(`${scope} package preserves sibling Skills while toggling one`, async () => {
    const f = fixture();
    const pkg = join(f.root, "fixture-pkg-two");
    put(join(pkg, "package.json"), { name: "fixture-pkg-two", pi: { skills: ["skills"] } });
    for (const name of ["fixture-target", "fixture-sibling"]) {
      put(join(pkg, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture\n---\nBody`);
    }
    if (scope === "global") put(join(f.agent, "settings.json"), { packages: [pkg] });
    else put(join(f.cwd, ".pi", "settings.json"), { packages: [{ source: pkg, skills: [], extensions: [] }] });
    let model = await loadProject(f.cwd, f.agent);
    row(model, "fixture-target").state = scope === "global" ? "off" : "on";
    saveProject(model);
    await assertNativeSkill(f, "fixture-target", scope !== "global");
    await assertNativeSkill(f, "fixture-sibling", scope === "global");
    model = await loadProject(f.cwd, f.agent);
    row(model, "fixture-target").state = "inherit";
    saveProject(model);
    await assertNativeSkill(f, "fixture-target", scope === "global");
    await assertNativeSkill(f, "fixture-sibling", scope === "global");
    if (scope === "global") {
      const restored = await loadProject(f.cwd, f.agent);
      assert.equal(restored.settings.data.packages, undefined);
    }
  });
}
