import cp from "child_process";
import fs from "fs/promises";
import path from "upath";
import * as cli from "./cli";
import * as gen from "./gen";
import * as logger from "./logger";
import * as substitutions from "./substitutions";
import type { PlasmicOpts } from "./types";
import { PlasmicOptsSchema } from "./validation";

type onRegisterPages = (
  pages: { name: string; projectId: string; path: string; url: string }[],
  config: any
) => Promise<void>;

export async function watchForChanges(
  { plasmicDir, pageDir }: PlasmicOpts,
  onRegisterPages?: onRegisterPages
) {
  const cliPath = path.join(plasmicDir, "node_modules", ".bin", process.platform === "win32" ? "plasmic.cmd":"plasmic");
  let currentConfig = await cli.readConfig(plasmicDir);
  const watchCmd = cp.spawn(
    "node",
    [cliPath, "watch", "--yes", "--metadata", "source=loader"],
    {
      cwd: plasmicDir,
      env: { ...process.env, PLASMIC_LOADER: "1" },
      stdio: "pipe",
    }
  );

  async function handleWatchCliOutput(data: string) {
    const content = data.toString();
    content
      .split("\n")
      .filter(Boolean)
      .forEach((text) => logger.cliInfo(text));

    // Once the CLI output this message, we know the components & configs were updated.
    const didUpdate = content.includes("updated to revision");
    if (didUpdate) {
      await gen.generateAll({ dir: plasmicDir, pageDir });
      currentConfig = await cli.readConfig(plasmicDir);
      if (onRegisterPages) {
        await onRegisterPages(
          cli.getPagesFromConfig(plasmicDir, currentConfig),
          currentConfig
        ).catch((e) => logger.crash(e.message, e));
      }
    }
  }
  watchCmd.stdout.on("data", (data: Buffer) =>
    handleWatchCliOutput(data.toString()).catch((e) =>
      logger.crash(e.message, e)
    )
  );
}

export async function checkLoaderConfig(opts: PlasmicOpts) {
  const savedConfigPath = path.join(
    opts.plasmicDir,
    ".plasmic-loader-config.json"
  );

  const currentConfig = JSON.stringify({ ...opts, watch: false });
  const savedConfig = await fs
    .readFile(savedConfigPath)
    .then((file) => file.toString())
    .catch(() => undefined);

  if (savedConfig === currentConfig) {
    return;
  }

  if (savedConfig !== undefined) {
    logger.info(
      "Detected a change in the previous config. Deleting .plasmic directory..."
    );
  }

  // Settings changed, so delete .plasmic dir.
  await fs.rm(opts.plasmicDir, { recursive: true, force: true });
  await fs.mkdir(opts.plasmicDir, { recursive: true });
  await fs.writeFile(savedConfigPath, JSON.stringify(opts));
}

export async function initLoader(userOpts: PlasmicOpts) {
  const opts: PlasmicOpts = await PlasmicOptsSchema.validateAsync(
    userOpts
  ).catch((error) => logger.crash(error.message));
  const { dir, pageDir, projects, plasmicDir, initArgs = {} } = opts;

  await checkLoaderConfig(opts);

  logger.info("Checking that your loader version is up to date.");
  await cli.ensureRequiredLoaderVersion();
  logger.info(`Syncing plasmic projects: ${projects.join(", ")}`);
  const plasmicExecPath = path.join(
    plasmicDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "plasmic.cmd":"plasmic"
  );

  await cli.tryInitializePlasmicDir(plasmicDir, initArgs);
  await cli.syncProject(plasmicDir, dir, plasmicExecPath, projects);

  if (opts.substitutions) {
    logger.info("Registering substitutions...");
    const config = await cli.readConfig(plasmicDir);
    substitutions.registerSubstitutions(plasmicDir, config, opts.substitutions);
    await cli.saveConfig(plasmicDir, config);
    await cli.fixImports(plasmicDir, plasmicExecPath);
  }

  logger.info("Generating loader...");

  await gen.generateAll({ dir: plasmicDir, pageDir });
}

export async function onPostInit(
  opts: PlasmicOpts,
  onRegisterPages?: onRegisterPages
) {
  if (onRegisterPages) {
    const config = await cli.readConfig(opts.plasmicDir);
    await onRegisterPages(
      cli.getPagesFromConfig(opts.plasmicDir, config),
      config
    ).catch((e) => logger.crash(e.message, e));
  }
  if (opts.watch) {
    await watchForChanges(opts, onRegisterPages);
  }
}

export async function maybeAddToGitIgnore(gitIgnorePath: string, name: string) {
  const file = await fs
    .readFile(gitIgnorePath)
    .then((content) => content.toString())
    .catch((err) => {
      logger.info(
        `Found error while trying to read .gitignore: ${err.message}\nPlease add "${name}" to your .gitignore.`
      );
      return "";
    });

  if (!file || file.includes(name)) return;
  await fs.writeFile(
    gitIgnorePath,
    `${file}\n# Plasmic loader code\n${name}\n`
  );
  logger.info(`Added "${name}" to your .gitignore.`);
}
