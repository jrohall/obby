import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, TextComponent, ButtonComponent, ColorComponent } from 'obsidian';
import { CalendarView, CALENDAR_VIEW_TYPE } from "./calendar-view";

// Define the structure for individual calendar folder settings
export interface CalendarFolderSetting {
	path: string;
	color: string;
}

interface MyPluginSettings {
	mySetting: string;
	calendarFolderSettings: CalendarFolderSetting[];
	showCompletedInSidebar: boolean;
	showCompletedInWeekView: boolean;
	showCompletedInDayView: boolean;
	showCompletedInAgenda: boolean;
	taskSidebarPosition?: 'right' | 'left';
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	calendarFolderSettings: [{ path: 'calendar-data', color: '#3a86ff' }],
	showCompletedInSidebar: true,
	showCompletedInWeekView: true,
	showCompletedInDayView: true,
	showCompletedInAgenda: true,
	taskSidebarPosition: 'right',
}

// Helper function for a few default colors
function getDefaultColors(): string[] {
	return ['#3a86ff', '#ff006e', '#fb5607', '#ffbe0b', '#8338ec', '#3a5a40', '#2ec4b6'];
}

function getRandomDefaultColor(existingColors: string[]): string {
	const colors = getDefaultColors();
	let availableColors = colors.filter(c => !existingColors.includes(c));
	if (availableColors.length === 0) { // If all default colors are used, pick a random one
		availableColors = colors;
	}
	return availableColors[Math.floor(Math.random() * availableColors.length)];
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	calendarView: CalendarView | null = null;

	async onload() {
		await this.loadSettings();
		await this.ensureCalendarFoldersExist();

		this.registerView(
			CALENDAR_VIEW_TYPE,
			(leaf) => new CalendarView(leaf, this)
		);

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('calendar-days', 'Open Calendar', (evt: MouseEvent) => {
			this.activateView();
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				console.log(editor.getSelection());
				editor.replaceSelection('Sample Editor Command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ObbyPluginSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	async onunload() {
		if (this.calendarView) {
			this.calendarView = null;
		}
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(CALENDAR_VIEW_TYPE);

		// Explicitly get a new leaf as a tab in the main workspace
		const leaf = this.app.workspace.getLeaf('tab');

		await leaf.setViewState({
			type: CALENDAR_VIEW_TYPE,
			active: true,
		});

		this.app.workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		await this.ensureCalendarFoldersExist();
		if (this.calendarView && this.calendarView.calendar) {
			this.calendarView.calendar.refetchEvents();
		}
	}

	async ensureCalendarFoldersExist(): Promise<void> {
		if (!this.settings.calendarFolderSettings) {
			this.settings.calendarFolderSettings = [DEFAULT_SETTINGS.calendarFolderSettings[0] || { path: 'calendar-data', color: '#3a86ff' }];
		}
		for (const config of this.settings.calendarFolderSettings) {
			if (!config.path || config.path.trim() === '') continue;
			try {
				const normalizedPath = config.path.trim();
				const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
				if (!folder) {
					await this.app.vault.createFolder(normalizedPath);
					new Notice(`Created calendar data folder: ${normalizedPath}`);
				} else if (!(folder instanceof TFolder)) {
					new Notice(`Path for calendar data exists but is not a folder: ${normalizedPath}. Please check your settings.`);
				}
			} catch (error: any) {
				if (!error.message.includes("Folder already exists")) {
					new Notice(`Error ensuring calendar data folder ${config.path.trim()} exists: ${error.message}`);
					console.error(`Error ensuring calendar data folder ${config.path.trim()} exists:`, error);
				}
			}
		}
	}

	async deleteEventFile(filePath: string) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file && file instanceof TFile) {
			try {
				await this.app.vault.delete(file);
			} catch (e: any) {
				new Notice(`Error deleting event file: ${e.message}`);
				console.error("Error deleting event file:", e);
			}
		} else {
			new Notice(`Could not find event file to delete at path: ${filePath}`);
			console.warn("Could not find event file to delete at path:", filePath);
		}
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class ObbyPluginSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: 'Obby Plugin Settings'});

		containerEl.createEl('h3', { text: 'Calendar Data Folders' });

		// Display existing folders
		if (this.plugin.settings.calendarFolderSettings.length === 0) {
			containerEl.createEl('p', { text: 'No calendar folders configured.' });
		}

		this.plugin.settings.calendarFolderSettings.forEach((config, index) => {
			const settingItem = new Setting(containerEl)
				.addText(text => text
					.setValue(config.path)
					.setPlaceholder('Folder path (e.g., Calendar/Work)')
					.onChange(async (value) => {
						this.plugin.settings.calendarFolderSettings[index].path = value.trim();
						await this.plugin.saveSettings();
						// No need to call this.display() here if saveSettings triggers refetch and UI update
						// However, if direct manipulation is complex, this.display() ensures consistency.
						// For now, let's assume saveSettings handles necessary updates or rely on Obsidian's reactivity.
						// If issues arise, uncommenting this.display() might be needed.
						// this.display(); 
					}))
				.addColorPicker(colorPicker => colorPicker
					.setValue(config.color)
					.onChange(async (value) => {
						this.plugin.settings.calendarFolderSettings[index].color = value;
						await this.plugin.saveSettings();
						// this.display();
					}))
				.addExtraButton(button => button
					.setIcon("trash")
					.setTooltip("Remove folder")
					.onClick(async () => {
						this.plugin.settings.calendarFolderSettings.splice(index, 1);
						await this.plugin.saveSettings();
						this.display(); // Refresh UI after removal
					}));
			
			// Adjust styling to prevent nameEl from taking up space if not used
			settingItem.nameEl.remove(); // Remove the default name element container
			settingItem.controlEl.style.width = '100%'; // Make control element take full width
			settingItem.controlEl.style.justifyContent = 'space-between';
		});
		
		containerEl.createEl('hr');
		// Add new folder input
		const addFolderSetting = new Setting(containerEl)
			.setDesc("Enter new folder path, choose a color, then click Add.");
		
		let newPathInput: TextComponent;
		let newColorInput: ColorComponent;
		const currentUsedColors = this.plugin.settings.calendarFolderSettings.map(c => c.color);
		const newColorForPicker = getRandomDefaultColor(currentUsedColors);

		addFolderSetting.addText(text => {
			newPathInput = text;
			text.setPlaceholder("e.g., Calendar/Personal");
		})
		.addColorPicker(picker => {
			newColorInput = picker;
			picker.setValue(newColorForPicker);
		})
		.addButton(button => button
			.setButtonText("Add Folder")
			.setCta()
			.onClick(async () => {
				const newPath = newPathInput.getValue().trim();
				const selectedColor = newColorInput.getValue();
				if (newPath && !this.plugin.settings.calendarFolderSettings.find(c => c.path === newPath)) {
					this.plugin.settings.calendarFolderSettings.push({ path: newPath, color: selectedColor });
					await this.plugin.saveSettings();
					this.display(); // Refresh UI to show new folder and clear inputs
				} else if (newPath && this.plugin.settings.calendarFolderSettings.find(c => c.path === newPath)) {
					new Notice("This folder path already exists.");
				} else if (!newPath) {
					new Notice("Folder path cannot be empty.");
				}
			}));
		// Adjust styling for add folder section
		addFolderSetting.nameEl.remove();
		addFolderSetting.controlEl.style.width = '100%';
		addFolderSetting.controlEl.style.justifyContent = 'space-between';

		new Setting(containerEl)
			.setName('Show completed tasks in sidebar')
			.setDesc('Toggle whether completed tasks are shown in the sidebar task list.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showCompletedInSidebar)
				.onChange(async (value) => {
					this.plugin.settings.showCompletedInSidebar = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Show completed tasks in week view')
			.setDesc('Toggle whether completed tasks are shown in the week view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showCompletedInWeekView)
				.onChange(async (value) => {
					this.plugin.settings.showCompletedInWeekView = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Show completed tasks in day view')
			.setDesc('Toggle whether completed tasks are shown in the day view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showCompletedInDayView)
				.onChange(async (value) => {
					this.plugin.settings.showCompletedInDayView = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Show completed tasks in agenda')
			.setDesc('Toggle whether completed tasks are shown in the agenda view.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showCompletedInAgenda)
				.onChange(async (value) => {
					this.plugin.settings.showCompletedInAgenda = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Task sidebar position')
			.setDesc('Choose whether the task sidebar appears on the right or left side of the calendar.')
			.addDropdown(drop => {
				drop.addOption('right', 'Right');
				drop.addOption('left', 'Left');
				drop.setValue(this.plugin.settings.taskSidebarPosition || 'right');
				drop.onChange(async (value) => {
					this.plugin.settings.taskSidebarPosition = value as 'right' | 'left';
					await this.plugin.saveSettings();
				});
			});
	}
}
