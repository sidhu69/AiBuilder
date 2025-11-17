// backend/fileManager.js
import fs from "fs";
import path from "path";
import archiver from "archiver";

export function createProjectFiles(jsonOutput, projectId) {
  const baseDir = path.join(process.cwd(), "projects");

  // Create /projects folder if not exists
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir);
  }

  // Create unique project folder
  const projectPath = path.join(baseDir, projectId);
  
  // If project exists, we're updating it
  if (!fs.existsSync(projectPath)) {
    fs.mkdirSync(projectPath);
  }

  // Loop through all JSON keys and create files
  Object.entries(jsonOutput).forEach(([filePath, content]) => {
    const fullPath = path.join(projectPath, filePath);
    const dir = path.dirname(fullPath);

    // Create folder(s) if needed
    fs.mkdirSync(dir, { recursive: true });

    // Write the file
    fs.writeFileSync(fullPath, content);
    console.log(`✅ Created: ${filePath}`);
  });

  return projectPath;
}

export function zipProject(projectPath, projectId) {
  return new Promise((resolve, reject) => {
    const zipDir = path.join(process.cwd(), "zips");

    // Create /zips folder if missing
    if (!fs.existsSync(zipDir)) {
      fs.mkdirSync(zipDir);
    }

    const zipPath = path.join(zipDir, `${projectId}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      console.log(`📦 ZIP created: ${archive.pointer()} bytes`);
      resolve(zipPath);
    });

    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(projectPath, false);
    archive.finalize();
  });
}
