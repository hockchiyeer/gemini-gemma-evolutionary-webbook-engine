const fs = require("fs");
const os = require("os");
const path = require("path");
// dynamically imported in main for ESM compatibility

const cucumberConfig = require("../.cypress-cucumber-preprocessorrc.json");

const projectRoot = path.resolve(__dirname, "..", "..");
const configuredJsonPath = path.resolve(
  projectRoot,
  cucumberConfig.json?.output ?? "test-results/chromeReport/cucumber-report.json"
);
const legacyJsonPath = path.resolve(projectRoot, "test-results/cucumber-report.json");
const stagedJsonDir = path.resolve(projectRoot, "test-results/chromeReport/cucumber-json");
const reportPath = path.resolve(
  projectRoot,
  "test-results/chromeReport/multiple-cucumber-html-report"
);
const reportIndexPath = path.join(reportPath, "index.html");

async function resolveJsonPath() {
  try {
    await fs.promises.access(configuredJsonPath, fs.constants.F_OK);
    return configuredJsonPath;
  } catch {
    await fs.promises.access(legacyJsonPath, fs.constants.F_OK);
    return legacyJsonPath;
  }
}

async function stageJsonFile(sourcePath) {
  await fs.promises.rm(stagedJsonDir, { recursive: true, force: true });
  await fs.promises.mkdir(stagedJsonDir, { recursive: true });
  const stagedPath = path.join(stagedJsonDir, path.basename(sourcePath));
  await fs.promises.copyFile(sourcePath, stagedPath);
}

async function main() {
  let jsonPath;
  try {
    jsonPath = await resolveJsonPath();
  } catch {
    throw new Error(
      `Cucumber JSON file not found at ${configuredJsonPath}. Run the Cypress feature tests first.`
    );
  }

  await stageJsonFile(jsonPath);
  await fs.promises.rm(reportPath, { recursive: true, force: true });

  const report = await import("multiple-cucumber-html-reporter");
  report.generate({
    jsonDir: stagedJsonDir,
    reportPath,
    pageTitle: "Cypress BDD Report",
    reportName: "Multiple Cucumber HTML Report",
    displayDuration: true,
    metadata: {
      browser: {
        name: process.env.BROWSER || "chrome",
      },
      device: "Local test machine",
      platform: {
        name: os.platform(),
        version: os.release(),
      },
    },
    customData: {
      title: "Run info",
      data: [
        { label: "Project", value: "Evolutionary Web-Book Engine" },
        { label: "Generated", value: new Date().toISOString() },
      ],
    },
  });

  console.log(`Multiple Cucumber HTML report: ${path.relative(projectRoot, reportIndexPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
