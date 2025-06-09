# Obby - Calendar and Task Manager for Obsidian

Obby is a powerful calendar and task management plugin for Obsidian that helps you organize your tasks and events in a visual calendar interface.

## Features

- **Calendar View**: Access a full calendar interface directly in Obsidian
- **Task Management**: Organize and track your tasks with visual calendar integration
- **Customizable Calendar Folders**: Create multiple calendar folders with different colors for better organization
- **Flexible Display Options**:
  - Toggle completed tasks visibility in sidebar
  - Toggle completed tasks visibility in week view
  - Toggle completed tasks visibility in day view
  - Toggle completed tasks visibility in agenda
- **Customizable Layout**: Choose your preferred task sidebar position (left or right)
- **Color Coding**: Assign different colors to different calendar folders for better visual organization

## Installation

1. Open Obsidian Settings
2. Go to Community Plugins
3. Search for "Obby"
4. Click Install
5. Enable the plugin

## Usage

1. Click the calendar icon in the left ribbon to open the calendar view
2. Configure your calendar folders in the plugin settings
3. Start adding tasks and events to your calendar

## Settings

The plugin offers several customization options:

- **Calendar Folders**: Add and configure multiple calendar folders with custom colors
- **Task Visibility**: Control how completed tasks are displayed across different views
- **Sidebar Position**: Choose whether the task sidebar appears on the left or right

## Development

This project uses TypeScript to provide type checking and documentation.

### First time developing plugins?

Quick starting guide for new plugin devs:

- Check if [someone already developed a plugin for what you want](https://obsidian.md/plugins)! There might be an existing plugin similar enough that you can partner up with.
- Make a copy of this repo as a template with the "Use this template" button (login to GitHub if you don't see it).
- Clone your repo to a local development folder. For convenience, you can place this folder in your `.obsidian/plugins/your-plugin-name` folder.
- Install NodeJS, then run `npm i` in the command line under your repo folder.
- Run `npm run dev` to compile your plugin from `main.ts` to `main.js`.
- Make changes to `main.ts` (or create new `.ts` files). Those changes should be automatically compiled into `main.js`.
- Reload Obsidian to load the new version of your plugin.
- Enable plugin in settings window.
- For updates to the Obsidian API run `npm update` in the command line under your repo folder.

## Support

If you find this plugin helpful, please consider supporting its development:

- Star the repository
- Report bugs or suggest features on GitHub
- Share with other Obsidian users

## License

This project is licensed under the MIT License - see the LICENSE file for details.
