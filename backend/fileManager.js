import fs from "fs";
import path from "path";

export function createProjectFiles(jsonOutput, projectId) {
  const baseDir = path.join(process.cwd(), "projects");

  // Create /projects folder if not exists
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir);
  }

  // Create unique project folder
  const projectPath = path.join(baseDir, projectId);
  fs.mkdirSync(projectPath);

  let parsed;
  try {
    parsed = JSON.parse(jsonOutput);
  } catch (error) {
    console.error("❌ JSON Parsing Error:", error);
    fs.writeFileSync(path.join(projectPath, "error_output.txt"), jsonOutput);
    return projectPath;
  }

  // Loop through all JSON keys
  Object.entries(parsed).forEach(([filePath, content]) => {
    const fullPath = path.join(projectPath, filePath);
    const dir = path.dirname(fullPath);

    // Create folder(s)
    fs.mkdirSync(dir, { recursive: true });

    // Write the file
    fs.writeFileSync(fullPath, content);
  });

  return projectPath;
}
import archiver from "archiver";

export function zipProject(projectPath, projectId) {
  return new Promise((resolve, reject) => {
    const zipDir = path.join(process.cwd(), "zips");

    // create /zips folder if missing
    if (!fs.existsSync(zipDir)) {
      fs.mkdirSync(zipDir);
    }

    const zipPath = path.join(zipDir, `${projectId}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip");

    output.on("close", () => resolve(zipPath));
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(projectPath, false);
    archive.finalize();
  });
}
