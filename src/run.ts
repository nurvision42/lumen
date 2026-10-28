import { fileURLToPath } from "node:url";
import { extractProject } from "./args.js";
import { breakdownCommand } from "./commands/breakdown.js";
import { captionsCommand } from "./commands/captions.js";
import { concatCommand } from "./commands/concat.js";
import { cutsCommand } from "./commands/cuts.js";
import { doctorCommand } from "./commands/doctor.js";
import { downloadCommand } from "./commands/download.js";
import { enhanceCommand } from "./commands/enhance.js";
import { feishuCommand } from "./commands/feishu.js";
import { fishCommand } from "./commands/fish.js";
import { genCommand } from "./commands/gen.js";
import { initCommand } from "./commands/init.js";
import { modelsCommand } from "./commands/models.js";
import { providersCommand } from "./commands/providers.js";
import { setupCommand } from "./commands/setup.js";
import { skillCommand } from "./commands/skill.js";
import { spriteCommand } from "./commands/sprite.js";
import { runsCommand } from "./commands/runs.js";
import { validateCommand } from "./commands/validate.js";
import { CliError } from "./errors.js";
import { helpText } from "./help.js";
import { packageRootFrom } from "./install/locate.js";
import { defaultIO, fail, line, type IO } from "./io.js";
import { resolveProject } from "./project.js";
import { autoinstallSkill, explicitSkillInstall } from "./skill/place.js";
import { readVersion } from "./version.js";

const packageRoot = packageRootFrom(fileURLToPath(import.meta.url));

export async function run(argv: string[], io: IO = defaultIO()): Promise<number> {
  try {
    if (!explicitSkillInstall(argv)) await autoinstallSkill(io, packageRoot, readVersion());
    if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
      line(io, helpText(readVersion()));
      return 0;
    }
    if (argv.includes("--version") || argv.includes("-V")) {
      line(io, readVersion());
      return 0;
    }

    const extracted = extractProject(argv);
    const [command, ...args] = extracted.argv;
    if (command === undefined) {
      line(io, helpText(readVersion()));
      return 0;
    }

    const project = resolveProject(io.cwd, extracted.project);
    switch (command) {
      case "init":
        return await initCommand(args, extracted.project, io);
      case "validate":
        return await validateCommand(args, project, io);
      case "models":
        return await modelsCommand(args, io);
      case "providers":
        return await providersCommand(args, project, io);
      case "breakdown":
        return await breakdownCommand(args, project, io, extracted.argv);
      case "gen":
        return await genCommand(args, project, io, extracted.argv);
      case "fish":
        return await fishCommand(args, project, io, extracted.argv);
      case "feishu":
        return await feishuCommand(args, io);
      case "enhance":
        return await enhanceCommand(args, project, io, extracted.argv);
      case "runs":
        return await runsCommand(args, project, io);
      case "concat":
        return await concatCommand(args, project, io);
      case "doctor":
        return await doctorCommand(args, project, io);
      case "download":
        return await downloadCommand(args, project, io);
      case "setup":
        return await setupCommand(args, project, io);
      case "skill":
        return await skillCommand(args, io);
      case "sprite":
        return await spriteCommand(args, project, io);
      case "cuts":
        return await cutsCommand(args, project, io);
      case "captions":
        return await captionsCommand(args, project, io, extracted.argv);
      default:
        throw new CliError(`unknown command: ${command}\n\n${helpText(readVersion())}`, 2);
    }
  } catch (err) {
    if (err instanceof CliError) {
      fail(io, err.message);
      return err.exitCode;
    }
    fail(io, err instanceof Error ? err.message : String(err));
    return 1;
  }
}
