import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
} from "obsidian";

import * as fs from "fs/promises";
import * as path from "path";

interface CopyExternalPluginSettings {
  targetDirectory: string;
}

const DEFAULT_SETTINGS: CopyExternalPluginSettings = {
  targetDirectory: "$HOME/cs/test-notes",
};

export default class CopyExternalPlugin extends Plugin {
  settings: CopyExternalPluginSettings;
  statusText: HTMLElement;

  async onload() {
    await this.loadSettings();

    // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
    this.statusText = this.addStatusBarItem();
    this.statusText.setText("Status Bar Text");

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
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

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
    const targetStat = await fs.stat(targetParent);
    if (targetStat.isDirectory()) {
      return;
    }

    await fs.mkdir(targetParent, { recursive: true });
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
    const targetPath = path.join(this.expandTargetPath(), file.path);
    await this.ensureParentDirectory(targetPath);

    // If we're creating a folder, then we want to create the corresponding folder in the target directory.
    if (fileStat?.type === "folder") {
      await fs.mkdir(targetPath);
    } else if (fileStat?.type === "file") {
      // Read the contents of the file. We do this as binary so we can read anything.
      const content = await file.vault.adapter.readBinary(file.path);
      // Write the new contents of the file to the target directory.
      await fs.writeFile(targetPath, Buffer.from(content));
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
    const targetPath = path.join(this.expandTargetPath(), file.path);
    await this.ensureParentDirectory(targetPath);

    // Read the contents of the file. We do this as binary so we can read anything.
    const content = await file.vault.adapter.readBinary(file.path);

    // Write the new contents of the file to the target directory.
    await fs.writeFile(targetPath, Buffer.from(content));
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
    await fs.rename(oldTargetPath, newTargetPath);
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
  }
}
