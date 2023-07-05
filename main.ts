import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
} from "obsidian";

import * as fs from "fs/promises";
import * as path from "path";
import { Stats } from "fs";

interface CopyExternalPluginSettings {
  targetDirectory: string;
  notifyCreate: boolean;
  notifyModify: boolean;
  notifyDelete: boolean;
  notifyRename: boolean;
}

const DEFAULT_SETTINGS: CopyExternalPluginSettings = {
  targetDirectory: "$HOME/cs/test-notes",
  notifyCreate: true,
  notifyModify: false,
  notifyDelete: true,
  notifyRename: true,
};

export default class CopyExternalPlugin extends Plugin {
  settings: CopyExternalPluginSettings;
  statusText: HTMLElement;

  async onload() {
    await this.loadSettings();

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new CopyExternalSettingTab(this.app, this));

    this.registerEvent(
      this.app.vault.on(
        "create",
        async (file: TAbstractFile) => await this.syncFileCreate(file)
      )
    );

    this.registerEvent(
      this.app.vault.on(
        "modify",
        async (file: TAbstractFile) => await this.syncFileModify(file)
      )
    );

    this.registerEvent(
      this.app.vault.on(
        "delete",
        async (file: TAbstractFile) => await this.syncFileDelete(file)
      )
    );

    this.registerEvent(
      this.app.vault.on(
        "rename",
        async (file: TAbstractFile, oldPath: string) =>
          await this.syncFileRename(file, oldPath)
      )
    );

    await this.syncExistingFiles();
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // Expand the target path
  //
  // This method will return the path in which to place the copies of the vault. This method essentially expands the
  // `$HOME` environment variable in the path.
  expandTargetPath(): string {
    const home = process.env.HOME;
    if (typeof home === "string") {
      return this.settings.targetDirectory.replace("$HOME", home);
    } else {
      return this.settings.targetDirectory;
    }
  }

  // Check to name sure that the target path (from the settings) exists.
  async targetPathExists(): Promise<boolean> {
    try {
      const targetStat = await fs.stat(this.expandTargetPath());
      return targetStat.isDirectory();
    } catch {
      return false;
    }
  }

  // Ensures that the parent directory of the given path exists, and if it does not, creates it.
  //
  // Note that this will not make sure that the 'targetDirectory' (from settings) exists, and we should make sure that
  // we call `targetPathExists()` before using this method.
  async ensureParentDirectory(targetPath: string) {
    const targetParent = path.dirname(targetPath);
    const targetStat = await this.safeStat(targetParent);
    if (targetStat && targetStat.isDirectory()) {
      return;
    }

    await fs.mkdir(targetParent, { recursive: true });
  }

  async ensureTargetPath(file: string): Promise<string> {
    const targetPath = path.join(this.expandTargetPath(), file);
    await this.ensureParentDirectory(targetPath);
    return targetPath;
  }

  async safeStat(file: string): Promise<Stats | null> {
    try {
      return await fs.stat(file);
    } catch {
      return null;
    }
  }

  async syncExistingFiles() {
    // Make sure that we can actually do any synchronisation
    if (!(await this.targetPathExists())) {
      console.warn(
        `Target path '${this.settings.targetDirectory}' does not exist; no synching will take place.`
      );
      return;
    }

    console.log("Syncing existing files ...");

    const targetDir = this.expandTargetPath();
    let fileCount = 0;
    let updated = 0;
    let created = 0;

    for (const file of this.app.vault.getFiles()) {
      fileCount += 1;

      // See if this file already exists in the target path
      const targetPath = path.join(targetDir, file.path);
      const targetStat = await this.safeStat(targetPath);

      if (targetStat === null) {
        // The target file in `targetPath` does not exist; we need to create it
        // Read the contents of the file. We do this as binary so we can ready anything.
        const content = await file.vault.adapter.readBinary(file.path);
        // Write the new contents of the file to the target directory.
        await this.ensureParentDirectory(targetPath);
        await fs.writeFile(targetPath, Buffer.from(content));
        created += 1;
      } else {
        // See if the file needs to be updated
        if (targetStat.mtime.getTime() < file.stat.mtime) {
          // Read the contents of the file. We do this as binary so we can ready anything.
          const content = await file.vault.adapter.readBinary(file.path);
          // Write the new contents of the file to the target directory.
          await fs.writeFile(targetPath, Buffer.from(content));
          updated += 1;
        }
      }
    }

    const message = `Synced ${fileCount} files; ${created} created, ${updated} updated.`;
    console.log(message);
    new Notice(message);
  }

  async syncFileCreate(file: TAbstractFile) {
    console.log(`Syncing new file: '${file.path}'`);

    // Make sure that we can actually do any synchronisation
    if (!(await this.targetPathExists())) {
      console.warn(
        `Target path '${this.settings.targetDirectory}' does not exist; no synching will take place.`
      );
      return;
    }

    // Take a look at what we're creating.
    const fileStat = await file.vault.adapter.stat(file.path);

    // Make sure that our parent directory exists in the target directory.
    const targetPath = await this.ensureTargetPath(file.path);

    // If we're creating a folder, then we want to create the corresponding folder in the target directory.
    if (fileStat?.type === "folder") {
      await fs.mkdir(targetPath);
    } else if (fileStat?.type === "file") {
      // Read the contents of the file. We do this as binary so we can read anything.
      const content = await file.vault.adapter.readBinary(file.path);
      // Write the new contents of the file to the target directory.
      await fs.writeFile(targetPath, Buffer.from(content));

      if (this.settings.notifyCreate) {
        new Notice(`Synced new file '${file.name}'`);
      }
    } else {
      console.warn(`Unknown file type: '${fileStat?.type}'`);
    }
  }

  async syncFileModify(file: TAbstractFile) {
    console.log(`Synching modified file: '${file.path}'`);

    // Make sure that we can actually do any synchronisation
    if (!(await this.targetPathExists())) {
      console.warn(
        `Target path '${this.settings.targetDirectory}' does not exist; no synching will take place.`
      );
      return;
    }

    // Compute the target path and make sure that the parent directory exists.
    const targetPath = await this.ensureTargetPath(file.path);

    // Read the contents of the file. We do this as binary so we can read anything.
    const content = await file.vault.adapter.readBinary(file.path);

    // Write the new contents of the file to the target directory.
    await fs.writeFile(targetPath, Buffer.from(content));

    if (this.settings.notifyModify) {
      new Notice(`Synced modified file '${file.name}'`);
    }
  }

  async syncFileDelete(file: TAbstractFile) {
    console.log(`Syncing deletion of file '${file.path}'`);

    // Make sure that we can actually do any synchronisation
    if (!(await this.targetPathExists())) {
      console.warn(
        `Target path '${this.settings.targetDirectory}' does not exist; no synching will take place.`
      );
      return;
    }

    // Compute the target path and make sure that the parent directory exists.
    const targetPath = path.join(this.expandTargetPath(), file.path);
    await fs.rm(targetPath);

    if (this.settings.notifyDelete) {
      new Notice(`Synced deleted file '${file.name}'`);
    }
  }

  async syncFileRename(file: TAbstractFile, oldPath: string) {
    console.log(`Syncing file rename from '${oldPath}' to '${file.path}'`);

    // Make sure that we can actually do any synchronisation
    if (!(await this.targetPathExists())) {
      console.warn(
        `Target path '${this.settings.targetDirectory}' does not exist; no synching will take place.`
      );
      return;
    }

    const expandedTarget = this.expandTargetPath();
    const oldTargetPath = path.join(expandedTarget, oldPath);
    const newTargetPath = path.join(expandedTarget, file.path);
    await this.ensureParentDirectory(newTargetPath);
    try {
      await fs.rename(oldTargetPath, newTargetPath);

      if (this.settings.notifyRename) {
        new Notice(`Synced rename file '${file.name}' (was '${oldPath}')`);
      }
    } catch {
      console.error(
        `Failed to rename '${oldTargetPath}' to '${newTargetPath}'`
      );
      new Notice(`Failed to rename '${oldTargetPath}' to '${newTargetPath}'`);
    }
  }
}

class CopyExternalSettingTab extends PluginSettingTab {
  plugin: CopyExternalPlugin;

  constructor(app: App, plugin: CopyExternalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings for external copy plugin." });

    new Setting(containerEl)
      .setName("Target Directory")
      .setDesc("Directory into which vault changes will be copied")
      .addText((text) =>
        text
          .setPlaceholder("Enter target directory")
          .setValue(this.plugin.settings.targetDirectory)
          .onChange(async (value) => {
            console.log("Target Directory: " + value);
            this.plugin.settings.targetDirectory = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Notifications" });

    new Setting(containerEl)
      .setName("Notify File Creation")
      .setDesc("Display a notification when a new file is synced")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.notifyCreate)
          .onChange(async (value) => {
            this.plugin.settings.notifyCreate = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Notify File Modifications")
      .setDesc("Display a notification when a file modification is synced")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.notifyModify)
          .onChange(async (value) => {
            this.plugin.settings.notifyModify = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Notify File Deletion")
      .setDesc("Display a notification when a new file deletion is synced")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.notifyDelete)
          .onChange(async (value) => {
            this.plugin.settings.notifyDelete = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Notify File Rename")
      .setDesc("Display a notification when a new file rename is synced")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.notifyRename)
          .onChange(async (value) => {
            this.plugin.settings.notifyRename = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
