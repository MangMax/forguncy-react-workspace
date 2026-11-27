import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repository = fileURLToPath(new URL("../", import.meta.url));
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  throw new Error("Usage: node scripts/pack-cli.mjs <version> [output-directory]");
}
const output = resolve(process.argv[3] ?? ".fgc/release");
const packageRoot = join(repository, "packages");
const stages = new Map();
const dependencies = {};

for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const root = join(packageRoot, entry.name);
  const content = await readFile(join(root, "package.json"), "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!content) continue;
  const manifest = JSON.parse(content);
  stages.set(manifest.name, { name: entry.name, root, manifest });
}
for (const stage of stages.values()) {
  for (const [name, range] of Object.entries(stage.manifest.dependencies ?? {})) {
    if (stages.has(name)) continue;
    if (dependencies[name] && dependencies[name] !== range) {
      throw new Error(`Conflicting release dependency ranges for ${name}`);
    }
    dependencies[name] = range;
  }
}

function publishedSpecifier(specifier, from) {
  if (specifier.startsWith(".")) return specifier.replace(/\.tsx?$/, ".js");
  const [scope, pkg, ...subpath] = specifier.split("/");
  const stage = stages.get(`${scope}/${pkg}`);
  if (!stage) return specifier;
  const target = stage.manifest.exports[subpath.length ? `./${subpath.join("/")}` : "."];
  if (typeof target !== "string") throw new Error(`Unknown workspace export ${specifier} from ${from}`);
  const address = relative(dirname(from), join(stage.name, target)).split(sep).join("/");
  return (address.startsWith(".") ? address : `./${address}`).replace(/\.tsx?$/, ".js");
}

function rewriteSpecifiers(from) {
  return context => source => {
    function visit(node) {
      if (ts.isStringLiteral(node)) {
        const parent = node.parent;
        const staticImport = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node;
        const dynamicImport = ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword;
        if (staticImport || dynamicImport) {
          const next = publishedSpecifier(node.text, from);
          if (next !== node.text) return ts.factory.createStringLiteral(next);
        }
      }
      return ts.visitEachChild(node, visit, context);
    }
    return ts.visitNode(source, visit);
  };
}

async function emitSources(source, target, prefix) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("__")) await emitSources(from, join(target, entry.name), join(prefix, entry.name));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec|d)\.tsx?$/.test(entry.name)) continue;
    const result = ts.transpileModule(await readFile(from, "utf8"), {
      fileName: from,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
      transformers: { before: [rewriteSpecifiers(join(prefix, entry.name))] },
      reportDiagnostics: true,
    });
    const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors?.length) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
        getCurrentDirectory: () => repository, getCanonicalFileName: name => name, getNewLine: () => "\n",
      }));
    }
    await writeFile(join(target, entry.name.replace(/\.tsx?$/, ".js")), result.outputText);
  }
}

const tempRoot = resolve(tmpdir());
const staging = await mkdtemp(join(tempRoot, "fgc-cli-release-"));
try {
  for (const stage of stages.values()) {
    const prefix = join(stage.name, "src");
    await emitSources(join(stage.root, "src"), join(staging, prefix), prefix);
  }
  await writeFile(join(staging, "package.json"), JSON.stringify({
    name: "@forguncy-react-workspace/cli",
    version,
    type: "module",
    engines: { node: ">=24" },
    bin: { "fgc-cell": "./cell-project/src/cli.js" },
    dependencies,
  }, null, 2) + "\n");
  await mkdir(output, { recursive: true });
  const npmEntry = process.env.npm_execpath;
  const npmScript = npmEntry && basename(npmEntry) === "npm-cli.js"
    ? npmEntry
    : process.platform === "win32"
      ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
      : undefined;
  const args = ["pack", "--quiet", "--pack-destination", output];
  const result = spawnSync(npmScript ? process.execPath : "npm", npmScript ? [npmScript, ...args] : args, {
    cwd: staging, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack exited with ${result.status}`);
} finally {
  if (dirname(staging) === tempRoot && basename(staging).startsWith("fgc-cli-release-")) {
    await rm(staging, { recursive: true, force: true });
  }
}
