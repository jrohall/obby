import { ItemView, WorkspaceLeaf, Modal, App, Setting, Notice, TFolder, TFile, TextComponent, SuggestModal, ButtonComponent } from "obsidian";
// We'll be interacting with the FullCalendar Calendar object
import { Calendar, EventApi } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction'; // Removed named import for EventClickArg
import MyPlugin from "./main"; // Import MyPlugin to access settings

// Define DateSelectArg more generically if direct import fails or is version-specific
interface DateSelectArg {
    startStr: string;
    endStr: string;
    allDay: boolean;
    // Add other properties from FullCalendar's select callback if needed
    view: any; // Or a more specific ViewApi type if you import it
    jsEvent: MouseEvent;
}

// Interface for the argument passed by FullCalendar's eventClick
interface EventClickArg { // This local interface will be used
    el: HTMLElement;
    event: EventApi;
    jsEvent: MouseEvent;
    view: any;
}

export const CALENDAR_VIEW_TYPE = "calendar-view";

// Define the structure of our calendar events
export interface CalendarEvent {
    id?: string; // Optional: Can be generated or be the file path
    title: string;
    start: string; // ISO8601 string
    end?: string;   // ISO8601 string, optional for all-day events
    allDay?: boolean;
    // We can add more properties like description, color, etc.
    fcEvent?: EventApi; // Add original FullCalendar event object if needed for complex updates

    // Fields for recurrence
    isRecurring?: boolean;
    daysOfWeek?: number[]; // 0=Sunday, 1=Monday, etc.
    startRecur?: string;   // ISO Date string (YYYY-MM-DD) for when recurrence begins
    endRecur?: string;     // ISO Date string (YYYY-MM-DD) for when recurrence ends (optional)
    // For timed recurring events, the original start/end will define the time of day.
    // Alternatively, add recurringStartTime, recurringEndTime if needed for more complex scenarios.
    targetFolderPath?: string;   // For new events, which folder to save to.
    originalFolderPath?: string; // Stores the original folder path for an existing event
    folderColor?: string; // Color for the event based on its folder
    extendedProps?: { [key: string]: any }; 
}

export class CalendarView extends ItemView {
    public calendar: Calendar | null = null;
    private plugin: MyPlugin; // Store reference to the plugin
    private tasksSidebar: HTMLElement | null = null;
    private isTasksSidebarOpen: boolean = false;
    private tasks: string[] = [];
    private resizeHandle: HTMLElement | null = null;
    private taskListEl: HTMLElement | null = null;
    private sidebarRefreshInterval: any = null;
    private sidebarOpenSections: { today: boolean; week: boolean; later: boolean } = { today: true, week: true, later: true };

    constructor(leaf: WorkspaceLeaf, plugin: MyPlugin) { // Accept plugin instance
        super(leaf);
        this.plugin = plugin; // Store plugin instance
        if (this.plugin) { // Ensure plugin is defined before assigning to it
            this.plugin.calendarView = this; // Assign this view to the plugin instance
        }
    }

    getViewType() {
        return CALENDAR_VIEW_TYPE;
    }

    getDisplayText() {
        return "Calendar";
    }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();

        // Create main calendar container with flex layout
        const isSidebarLeft = this.plugin.settings.taskSidebarPosition === 'left';
        const mainContainer = container.createEl("div", { 
            attr: { 
                style: `display: flex; flex-direction: ${isSidebarLeft ? 'row-reverse' : 'row'}; width: 100%; height: 100%; position: relative; overflow: hidden;` 
            } 
        });

        const calendarEl = mainContainer.createEl("div", { 
            attr: { 
                id: "calendar-container", 
                style: `width: 100%; height: 100%; transition: all 0.3s ease; position: relative;` 
            } 
        });

        // Get persisted sidebar width
        let sidebarWidth = 300;
        const savedSidebarWidth = localStorage.getItem('obby-tasks-sidebar-width');
        if (savedSidebarWidth) {
            const parsed = parseInt(savedSidebarWidth, 10);
            if (!isNaN(parsed)) sidebarWidth = Math.max(300, Math.min(500, parsed));
        }

        // Create tasks sidebar container
        this.tasksSidebar = mainContainer.createEl("div", {
            attr: {
                id: "tasks-sidebar",
                style: `width: 300px; min-width: 300px; max-width: 300px; height: 100%; border-${isSidebarLeft ? 'right' : 'left'}: 1px solid var(--background-modifier-border); background: var(--background-primary); display: flex; flex-direction: column; transition: transform 0.3s ease; transform: translateX(${isSidebarLeft ? '-100%' : '100%'}); position: absolute; ${isSidebarLeft ? 'left: 0;' : 'right: 0;'} z-index: 1;`
            }
        });
        // REMOVE: Resize handle and all resizing logic
        this.resizeHandle = null;

        // Set initial max-width CSS variable
        document.documentElement.style.setProperty('--obby-task-max-width', '210px');
        // Set initial calendar container width and margin
        const calendarContainer = document.getElementById('calendar-container');
        if (calendarContainer) {
            calendarContainer.style.width = '100%';
            calendarContainer.style.marginRight = '0';
        }

        // --- TASKS SIDEBAR CONTENT ---
        const tasksHeader = this.tasksSidebar.createEl("h3", { text: "todos" });
        // Button row for 'New +' and 'Filters'
        const buttonRow = this.tasksSidebar.createDiv();
        buttonRow.style.display = 'flex';
        buttonRow.style.gap = '8px';
        buttonRow.style.marginBottom = '16px';
        // Add new todo button
        const addTodoBtn = buttonRow.createEl("button", { text: "New +", attr: { style: "flex: 1 1 0; padding: 10px 0; border-radius: 4px; border: none; background: var(--interactive-accent); color: var(--text-on-accent); font-weight: bold; cursor: pointer; font-size: 1em;" } });
        // Filter button
        const filterBtn = buttonRow.createEl('button', { text: 'Filters', attr: { style: 'flex: 1 1 0; padding: 10px 0; border-radius: 4px; border: 1px solid var(--background-modifier-border); background: var(--background-secondary); color: var(--text-normal); font-size: 1em; cursor: pointer;' } });

        // Load persisted filter settings
        let currentFolderFilter = '';
        let currentDueFilter = '';
        let currentImportanceFilter = '';
        const savedFilter = localStorage.getItem('obby-tasks-filter');
        if (savedFilter) {
            try {
                const parsed = JSON.parse(savedFilter);
                currentFolderFilter = parsed.folder || '';
                currentDueFilter = parsed.due || '';
                currentImportanceFilter = parsed.importance || '';
            } catch {}
        }

        // Filter modal
        class FilterModal extends Modal {
            onApply: (folder: string, due: string, importance: string) => void;
            folders: string[];
            currentFolder: string;
            currentDue: string;
            currentImportance: string;
            constructor(app: App, folders: string[], currentFolder: string, currentDue: string, currentImportance: string, onApply: (folder: string, due: string, importance: string) => void) {
                super(app);
                this.folders = folders;
                this.currentFolder = currentFolder;
                this.currentDue = currentDue;
                this.currentImportance = currentImportance;
                this.onApply = onApply;
            }
            onOpen() {
                const { contentEl } = this;
                contentEl.empty();
                contentEl.createEl('h2', { text: 'Filter todos' });
                // Folder/category filter
                const folderLabel = contentEl.createEl('label', { text: 'Category', attr: { style: 'display: block; margin-top: 12px; margin-bottom: 4px;' } });
                const folderSelect = contentEl.createEl('select', { attr: { style: 'width: 100%; padding: 4px; border-radius: 4px; border: 1px solid var(--background-modifier-border); margin-bottom: 12px;' } });
                folderSelect.createEl('option', { text: 'All categories', value: '' });
                this.folders.forEach(f => {
                    folderSelect.createEl('option', { text: f, value: f });
                });
                folderSelect.value = this.currentFolder;
                // Due date filter
                const dueLabel = contentEl.createEl('label', { text: 'Due date', attr: { style: 'display: block; margin-bottom: 4px;' } });
                const dueSelect = contentEl.createEl('select', { attr: { style: 'width: 100%; padding: 4px; border-radius: 4px; border: 1px solid var(--background-modifier-border); margin-bottom: 12px;' } });
                dueSelect.createEl('option', { text: 'All due dates', value: '' });
                dueSelect.createEl('option', { text: 'Due today', value: 'today' });
                dueSelect.createEl('option', { text: 'Overdue', value: 'overdue' });
                dueSelect.createEl('option', { text: 'No due date', value: 'none' });
                dueSelect.value = this.currentDue;
                // Importance filter
                const importanceLabel = contentEl.createEl('label', { text: 'Importance', attr: { style: 'display: block; margin-bottom: 4px;' } });
                const importanceSelect = contentEl.createEl('select', { attr: { style: 'width: 100%; padding: 4px; border-radius: 4px; border: 1px solid var(--background-modifier-border);' } });
                importanceSelect.createEl('option', { text: 'All', value: '' });
                importanceSelect.createEl('option', { text: 'High', value: 'high' });
                importanceSelect.createEl('option', { text: 'Medium', value: 'medium' });
                importanceSelect.createEl('option', { text: 'Low', value: 'low' });
                importanceSelect.createEl('option', { text: 'None', value: 'none' });
                importanceSelect.value = this.currentImportance;
                // Apply button
                const applyBtn = contentEl.createEl('button', { text: 'Apply', attr: { style: 'width: 100%; margin-top: 18px; padding: 8px 0; border-radius: 4px; border: none; background: var(--interactive-accent); color: var(--text-on-accent); font-weight: bold; font-size: 1em; cursor: pointer;' } });
                applyBtn.onclick = () => {
                    this.onApply(folderSelect.value, dueSelect.value, importanceSelect.value);
                    this.close();
                };
            }
        }

        filterBtn.onclick = () => {
            new FilterModal(
                this.app,
                this.plugin.settings.calendarFolderSettings.map((f: any) => f.path),
                currentFolderFilter,
                currentDueFilter,
                currentImportanceFilter,
                (folder, due, importance) => {
                    currentFolderFilter = folder;
                    currentDueFilter = due;
                    currentImportanceFilter = importance;
                    localStorage.setItem('obby-tasks-filter', JSON.stringify({ folder, due, importance }));
                    renderFilteredTasks();
                }
            ).open();
        };

        this.taskListEl = this.tasksSidebar.createEl("ul", { attr: { style: "list-style: none; padding: 0; margin: 0; flex: 1; overflow-y: auto;" } });
        const taskList = this.taskListEl;
        addTodoBtn.onclick = () => {
            new TaskModal(this.app, this.plugin, this.plugin.settings.calendarFolderSettings.map((f: any) => f.path), 
                () => { 
                    this.loadAndRenderTasks(taskList, currentFolderFilter, currentDueFilter, currentImportanceFilter);
                    if (this.calendar) { this.calendar.refetchEvents(); }
                }, 
                undefined, undefined).open();
        };
        // Initial render
        const renderFilteredTasks = () => {
            this.loadAndRenderTasks(taskList, currentFolderFilter, currentDueFilter, currentImportanceFilter);
        };
        renderFilteredTasks();

        // Add transition end listener to handle calendar updates
        this.tasksSidebar.addEventListener('transitionend', () => {
            if (this.calendar) {
                this.calendar.updateSize();
            }
        });

        this.calendar = new Calendar(calendarEl, {
            plugins: [ dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin ],
            initialView: 'timeGridWeek',
            headerToolbar: {
                left: 'prev,next today tasks addTask',
                center: 'title',
                right: 'dayGridMonth,timeGridWeek,timeGridDay,agendaWeek'
            },
            customButtons: {
                tasks: {
                    text: 'todos',
                    click: () => this.toggleTasksSidebar()
                },
                addTask: {
                    text: '+',
                    click: () => {
                        new TaskModal(
                            this.app,
                            this.plugin,
                            this.plugin.settings.calendarFolderSettings.map((f: any) => f.path),
                            () => {
                                if (this.taskListEl) this.loadAndRenderTasks(this.taskListEl);
                                if (this.calendar) this.calendar.refetchEvents();
                            },
                            undefined,
                            undefined
                        ).open();
                    }
                }
            },
            editable: true,
            selectable: true,
            select: this.handleDateSelect.bind(this),
            eventClick: this.handleEventClick.bind(this),
            eventDrop: (dropInfo: any) => {
                if (dropInfo.event.extendedProps.isTodo) {
                    this.handleTodoDrop(dropInfo);
                } else {
                    this.handleEventDrop(dropInfo);
                }
            },
            eventResize: (resizeInfo: any) => {
                if (resizeInfo.event.extendedProps.isTodo) {
                    new Notice("Resizing is not supported for todos.");
                    resizeInfo.revert();
                    return;
                }
                this.handleEventResize(resizeInfo);
            },
            events: async () => await this.loadEvents(),

            // --- Step 3: Add eventContent for custom todo rendering ---
            eventContent: (arg) => {
                const { event, view } = arg;
                const extendedProps = event.extendedProps;

                if (extendedProps && extendedProps.isTodo) {
                    const container = document.createElement('div');
                    container.style.display = 'flex';
                    container.style.alignItems = 'center';

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    // --- FIX: Use completedDates for recurring tasks ---
                    let isChecked = false;
                    if (extendedProps.isRecurring && extendedProps.due && Array.isArray(extendedProps.completedDates)) {
                        isChecked = extendedProps.completedDates.includes(extendedProps.due);
                    } else {
                        isChecked = !!extendedProps.completed;
                    }
                    checkbox.checked = isChecked;
                    checkbox.style.marginRight = '5px';
                    checkbox.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const newCompleted = checkbox.checked;
                        event.setExtendedProp('completed', newCompleted);
                        try {
                            if (extendedProps.isRecurring && extendedProps.due) {
                                await this.updateRecurringTodoCompletion(extendedProps.filePath, extendedProps.due, newCompleted);
                            } else {
                                await this.updateTodoCompletionInFile(extendedProps.filePath, newCompleted);
                            }
                            setTimeout(() => {
                                if (this.calendar) this.calendar.refetchEvents();
                                if (this.taskListEl) {
                                    this.loadAndRenderTasks(this.taskListEl);
                                }
                            }, 100);
                        } catch (error) {
                            new Notice('Failed to update todo completion status.');
                            checkbox.checked = !newCompleted;
                            event.setExtendedProp('completed', !newCompleted);
                        }
                    });
                    checkbox.classList.add('obby-todo-checkbox');
                    if (!view.type.startsWith('list')) {
                        container.appendChild(checkbox);
                    }

                    const titleEl = document.createElement('span');
                    titleEl.textContent = event.title;
                    if (isChecked) {
                        titleEl.style.textDecoration = 'line-through';
                        titleEl.style.opacity = '0.7';
                    }
                    container.appendChild(titleEl);
                    return { domNodes: [container] };
                }
                const titleDiv = document.createElement('div');
                titleDiv.innerHTML = event.title;
                return { domNodes: [titleDiv] };
            },
            // --- End Step 3 ---

            // --- Step 4: Add eventOrder for agenda view sorting ---
            eventOrder: (a: EventApi, b: EventApi) => {
                const aIsAllDay = a.allDay;
                const bIsAllDay = b.allDay;
                const aIsTodo = a.extendedProps.isTodo || false;
                const bIsTodo = b.extendedProps.isTodo || false;

                // Prioritize all-day regular events over all-day todos
                if (aIsAllDay && bIsAllDay) {
                    if (!aIsTodo && bIsTodo) { // a is a regular event, b is a todo
                        return -1; // a comes first
                    }
                    if (aIsTodo && !bIsTodo) { // a is a todo, b is a regular event
                        return 1;  // b comes first
                    }
                    // If both are all-day events or both are all-day todos,
                    // we can rely on default sorting or add a secondary sort key (e.g., title)
                    // return a.title.localeCompare(b.title); // Optional: secondary sort by title
                }

                // Fallback to default FullCalendar sorting for other cases
                // (e.g., timed events, or comparing all-day with timed).
                // FullCalendar naturally separates all-day from timed events in timeGrid views.
                return 0; 
            },
            // --- End Step 4 ---

            // --- Add eventDidMount to set CSS variable for todo folder color ---
            eventDidMount: (arg) => {
                if (arg.event.extendedProps && arg.event.extendedProps.isTodo) {
                    if (arg.event.extendedProps.originalColor) {
                        arg.el.style.setProperty('--todo-folder-color', arg.event.extendedProps.originalColor);
                    }
                    if (arg.el.classList.contains('fc-list-event')) {
                        const dotCell = arg.el.querySelector('.fc-list-event-graphic');
                        if (dotCell) {
                            dotCell.innerHTML = '';
                            const checkbox = document.createElement('input');
                            checkbox.type = 'checkbox';
                            // --- FIX: Use completedDates for recurring tasks in agenda/list view ---
                            let isChecked = false;
                            if (arg.event.extendedProps.isRecurring && arg.event.extendedProps.due && Array.isArray(arg.event.extendedProps.completedDates)) {
                                isChecked = arg.event.extendedProps.completedDates.includes(arg.event.extendedProps.due);
                            } else {
                                isChecked = !!arg.event.extendedProps.completed;
                            }
                            checkbox.checked = isChecked;
                            checkbox.style.margin = '0 auto';
                            checkbox.style.display = 'block';
                            checkbox.onclick = async (e) => {
                                e.stopPropagation();
                                const newCompleted = checkbox.checked;
                                arg.event.setExtendedProp('completed', newCompleted);
                                try {
                                    if (arg.event.extendedProps.isRecurring && arg.event.extendedProps.due) {
                                        await this.updateRecurringTodoCompletion(arg.event.extendedProps.filePath, arg.event.extendedProps.due, newCompleted);
                                    } else {
                                        await this.updateTodoCompletionInFile(arg.event.extendedProps.filePath, newCompleted);
                                    }
                                    setTimeout(() => {
                                        if (this.calendar) this.calendar.refetchEvents();
                                        if (this.taskListEl) {
                                            this.loadAndRenderTasks(this.taskListEl);
                                        }
                                    }, 100);
                                } catch (error) {
                                    new Notice('Failed to update todo completion status.');
                                    checkbox.checked = !newCompleted;
                                    arg.event.setExtendedProp('completed', !newCompleted);
                                }
                            };
                            dotCell.appendChild(checkbox);
                        }
                    }
                }
            },
            // --- End eventDidMount ---

            height: 'parent',

            allDaySlot: true,
            slotMinTime: "00:00:00",
            slotMaxTime: "24:00:00",
            slotLabelInterval: { hours: 1 },
            slotLabelFormat: [
                { hour: 'numeric', meridiem: 'short', hour12: true }
            ],
            dayHeaderFormat: {
                weekday: 'short',
                month: 'numeric',
                day: 'numeric',
                omitCommas: true
            },
            eventTimeFormat: {
                hour: 'numeric',
                minute: '2-digit',
                meridiem: false,
                hour12: true
            },
            displayEventEnd: true,

            // Add current time indicator
            nowIndicator: true,
            now: new Date(), // Initialize with current time

            views: {
                dayGridMonth: {
                    dayHeaderFormat: { weekday: 'short' } // Only show weekday (e.g., 'Sun') in month view headers
                },
                timeGridWeek: {
                    type: 'timeGridWeek',
                    buttonText: 'week'
                },
                timeGridDay: {
                    type: 'timeGridDay',
                    buttonText: 'day'
                },
                agendaWeek: {
                    type: 'list',
                    duration: { days: 8 },
                    buttonText: 'agenda',
                    stickyHeaderDates: false,
                    visibleRange: () => {
                        const start = new Date();
                        start.setHours(0,0,0,0);
                        const end = new Date(start);
                        end.setDate(start.getDate() + 8);
                        return { start, end };
                    },
                    dayHeaderFormat: { 
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        omitCommas: true
                    },
                    dayHeaderDidMount: (arg) => {
                        const today = new Date();
                        today.setHours(0,0,0,0);
                        const headerDate = new Date(arg.date);
                        headerDate.setHours(0,0,0,0);
                        
                        if (headerDate.getTime() === today.getTime()) {
                            // Find the cushion element and style it
                            const cushion = arg.el.querySelector('.fc-list-day-cushion');
                            if (cushion) {
                                cushion.setAttribute('style', `
                                    background-color: var(--obby-calendar-today-bg) !important;
                                    color: var(--text-normal) !important;
                                    font-weight: bold !important;
                                `);
                            }
                        }
                    }
                }
            }
        });

        // Add custom CSS for the now indicator
        const style = document.createElement('style');
        style.textContent = `
            .fc-timegrid-now-indicator-line {
                border-color: var(--text-error);
                border-width: 2px;
            }
            .fc-timegrid-now-indicator-arrow {
                border-color: var(--text-error);
                border-width: 5px;
            }

            /* Custom styling for current day highlight */
            .fc .fc-day-today {
                background-color: var(--obby-calendar-today-bg) !important;
            }

            /* Add more horizontal spacing */
            .fc-timegrid-slot-label {
                padding: 0 4px !important;
                min-width: 60px !important;
                text-align: left !important;
            }

            .fc-timegrid-slot {
                padding: 0 4px !important;
            }

            .fc-event {
                margin: 0 4px !important;
                padding: 2px 4px !important;
            }

            .fc-timegrid-event {
                margin: 0 4px !important;
                padding: 2px 4px !important;
            }

            .fc-event-title {
                padding: 0 !important;
                margin-left: 0 !important;
                text-align: left !important;
            }

            /* Align event times */
            .fc-event-time {
                text-align: left !important;
                padding-right: 4px !important;
                margin-right: 4px !important;
            }

            /* Remove extra padding from event content */
            .fc-event-main {
                padding: 0 !important;
            }

            /* List view event hover matches current day highlight */
            .fc-list-event:hover td {
                background-color: var(--background-modifier-hover) !important;
            }
            .theme-dark .fc-list-event:hover td {
                background-color: rgba(0, 0, 0, 0.3) !important;
            }
            .theme-light .fc-list-event:hover td {
                background-color: rgba(0, 0, 0, 0.15) !important;
            }

            /* --- Step 4: CSS for Todo Strips in TimeGrid --- */


            /* Ensure the general .fc-event class also respects this for todos if there are conflicts */
            /* These might be redundant if specificity is handled well by .fc-event-is-todo itself */
            .fc-event.fc-event-is-todo {
                /* background-color: var(--background-primary) !important;  Covered by .fc-event-is-todo */
                /* border-color: var(--background-modifier-border) !important; Covered by .fc-event-is-todo */
            }

            /* Specificity for different views if needed - likely covered by .fc-event-is-todo */
            .fc-daygrid-event.fc-event-is-todo {
                /* background-color: var(--background-primary) !important; */
            }
            .fc-timegrid-event.fc-event-is-todo {
                 /* background-color: var(--background-primary) !important; */
            }

            /* --- Fixed height and scroll for all-day section in timeGrid views --- */
            .fc-timegrid-view .fc-daygrid-body-natural .fc-daygrid-day-events,
            .fc-timegrid-view .fc-daygrid-body-liquid .fc-daygrid-day-events, /* Targeting the event container within all-day slot */
            .fc-timeGridWeek-view .fc-daygrid-body-natural .fc-daygrid-day-events,
            .fc-timeGridWeek-view .fc-daygrid-body-liquid .fc-daygrid-day-events,
            .fc-timeGridDay-view .fc-daygrid-body-natural .fc-daygrid-day-events,
            .fc-timeGridDay-view .fc-daygrid-body-liquid .fc-daygrid-day-events {
                max-height: 60px; /* Reduced height, adjust as needed */
                overflow-y: auto !important; 
                -webkit-overflow-scrolling: touch; 
            }

            /* Styling the scrollbar for the all-day section to be less obtrusive */
            .fc-timegrid-view .fc-daygrid-day-events::-webkit-scrollbar {
                width: 5px; /* Width of the scrollbar */
            }
            .fc-timegrid-view .fc-daygrid-day-events::-webkit-scrollbar-track {
                background: transparent; /* Make the track transparent */
            }
            .fc-timegrid-view .fc-daygrid-day-events::-webkit-scrollbar-thumb {
                background-color: var(--background-modifier-border-hover, rgba(128, 128, 128, 0.5)); /* A semi-transparent gray, or theme variable */
                border-radius: 10px;
                border: 1px solid transparent; /* Optional: adds a little padding around thumb */
            }
            .fc-timegrid-view .fc-daygrid-day-events::-webkit-scrollbar-thumb:hover {
                background-color: var(--background-modifier-border-focus, rgba(128, 128, 128, 0.8)); /* Darker on hover */
            }
            /* --- End fixed height for all-day --- */

        `;
        document.head.appendChild(style);

        this.calendar.render();

        // Update the now indicator every minute
        setInterval(() => {
            if (this.calendar) {
                this.calendar.setOption('now', new Date());
            }
        }, 60000); // Update every minute

        if (this.sidebarRefreshInterval) clearInterval(this.sidebarRefreshInterval);
        this.sidebarRefreshInterval = setInterval(() => {
            if (this.taskListEl) this.loadAndRenderTasks(this.taskListEl);
        }, 1000);
    }

    handleDateSelect(selectionInfo: DateSelectArg) {
        new EventModal(this.app, this.plugin, (result: CalendarEvent) => {
            if (result.id && result.isRecurring && result.fcEvent) {
                this.updateEvent(result); 
            } else if (result.id) {
                this.updateEvent(result);
            } else {
                this.saveEvent(result);
            }
        }, this.plugin.settings.calendarFolderSettings.map((f: any) => f.path), undefined, selectionInfo.startStr, selectionInfo.endStr, selectionInfo.allDay, false).open();
    }

    handleEventClick(clickInfo: EventClickArg) {
        const clickedEvent = clickInfo.event; // clickedEvent is an EventApi

        // --- Step 2: Basic Click Handling for Todos ---
        if (clickedEvent.extendedProps.isTodo) {
            // --- Step 3: Open TaskModal for todos ---
            const { filePath, title, description, due, dueTime, priority, folderPath, isRecurring, daysOfWeek, startRecur, endRecur } = clickedEvent.extendedProps;
            new TaskModal(
                this.app,
                this.plugin,
                this.plugin.settings.calendarFolderSettings.map((f: any) => f.path),
                () => { if (this.calendar) this.calendar.refetchEvents(); }, // Refresh callback
                filePath,
                {
                    title: clickedEvent.title, // Use current event title (might not have [DONE])
                    description: description,
                    due: due,
                    dueTime: dueTime,
                    priority: priority,
                    folder: folderPath,
                    isRecurring: isRecurring,
                    daysOfWeek: daysOfWeek,
                    startRecur: startRecur,
                    endRecur: endRecur
                }
            ).open();
            return;
        }
        // --- End Step 2 ---

        const eventData: CalendarEvent = {
            id: clickedEvent.id, 
            title: clickedEvent.title,
            start: clickedEvent.startStr, 
            end: clickedEvent.endStr,     
            allDay: clickedEvent.allDay,
            fcEvent: clickedEvent, 
            isRecurring: !!clickedEvent.extendedProps.isRecurring,
            // Retrieve recurrence properties primarily from extendedProps
            daysOfWeek: clickedEvent.extendedProps.daysOfWeek || [], // Default to empty array if not found
            startRecur: clickedEvent.extendedProps.startRecur, // Will be undefined if not found
            endRecur: clickedEvent.extendedProps.endRecur,     // Will be undefined if not found
        };

        new EventModal(this.app, this.plugin, (result: CalendarEvent) => {
             if (result.id) {
                this.updateEvent(result);
            } else { 
                this.saveEvent(result);
            }
        }, this.plugin.settings.calendarFolderSettings.map((f: any) => f.path), eventData, undefined, undefined, undefined, true).open();
    }

    handleEventDrop(dropInfo: any) {
        const event = dropInfo.event;
        const eventId = event.id;
        const newStart = event.startStr;
        const newEnd = event.endStr;
        const newAllDay = event.allDay;

        // Get the original file to ensure we have the correct folder path
        const originalFile = this.app.vault.getAbstractFileByPath(eventId);
        if (!(originalFile instanceof TFile)) {
            new Notice("Error: Could not find original event file.");
            return;
        }

        // Create updated event data
        const updatedEvent: CalendarEvent = {
            id: eventId,
            title: event.title,
            start: newStart,
            end: newEnd,
            allDay: newAllDay,
            isRecurring: event.extendedProps.isRecurring,
            daysOfWeek: event.extendedProps.daysOfWeek,
            startRecur: event.extendedProps.startRecur,
            endRecur: event.extendedProps.endRecur,
            folderColor: event.extendedProps.folderColor,
            targetFolderPath: originalFile.parent?.path,
            originalFolderPath: originalFile.parent?.path
        };

        // Update the event
        this.updateEvent(updatedEvent);
    }

    handleEventResize(resizeInfo: any) {
        const event = resizeInfo.event;
        const eventId = event.id;
        const newStart = event.startStr;
        const newEnd = event.endStr;

        // Get the original file to ensure we have the correct folder path
        const originalFile = this.app.vault.getAbstractFileByPath(eventId);
        if (!(originalFile instanceof TFile)) {
            new Notice("Error: Could not find original event file.");
            return;
        }

        // Create updated event data
        const updatedEvent: CalendarEvent = {
            id: eventId,
            title: event.title,
            start: newStart,
            end: newEnd,
            allDay: event.allDay,
            isRecurring: event.extendedProps.isRecurring,
            daysOfWeek: event.extendedProps.daysOfWeek,
            startRecur: event.extendedProps.startRecur,
            endRecur: event.extendedProps.endRecur,
            folderColor: event.extendedProps.folderColor,
            targetFolderPath: originalFile.parent?.path,
            originalFolderPath: originalFile.parent?.path
        };

        // Update the event
        this.updateEvent(updatedEvent);
    }

    async saveEvent(event: CalendarEvent) {
        let targetFolderPath = event.targetFolderPath;

        if (!targetFolderPath) {
            // If no target folder is specified on the event, try to use the first configured folder.
            if (this.plugin.settings.calendarFolderSettings && this.plugin.settings.calendarFolderSettings.length > 0) {
                targetFolderPath = this.plugin.settings.calendarFolderSettings[0].path;
                if (targetFolderPath) { // Ensure the first folder path is not empty
                    new Notice(`No folder specified for event, defaulting to: ${targetFolderPath}`);
                } else {
                    // Handle case where the first folder path might be empty string
                    new Notice("Cannot save event: The default calendar folder path is empty. Please check plugin settings.");
                    return;
                }
            } else {
                new Notice("Cannot save event: No calendar data folders configured. Please set at least one in plugin settings.");
                return;
            }
        }
        event.targetFolderPath = targetFolderPath; // Ensure it's set on the event object for clarity

        // Get the folder color from settings
        const folderSetting = this.plugin.settings.calendarFolderSettings.find(s => s.path === targetFolderPath);
        if (folderSetting) {
            event.folderColor = folderSetting.color;
        }

        try {
            const folder = this.app.vault.getAbstractFileByPath(targetFolderPath);
            if (!folder) {
                await this.app.vault.createFolder(targetFolderPath);
                new Notice(`Created folder: ${targetFolderPath}`);
            } else if (!(folder instanceof TFolder)) {
                new Notice(`Path ${targetFolderPath} exists but is not a folder. Cannot save event.`);
                return;
            }
        } catch (e: any) {
            if (!e.message.includes("Folder already exists")) {
                 new Notice(`Error creating/accessing folder ${targetFolderPath}: ${e.message}`);
                 console.error(`Error creating/accessing folder ${targetFolderPath}:`, e);
                 return;
            }
        }
        
        const sanitizedTitle = (event.title || 'Untitled Event').replace(/[\\/:*?"<>|]/g, '');
        const dateForFilename = event.isRecurring && event.startRecur ? event.startRecur : event.start;
        const baseFilename = `${sanitizedTitle}-${dateForFilename.substring(0,10)}`;
        let finalFilename = `${targetFolderPath}/${baseFilename}.md`;
        let counter = 0;
        while (this.app.vault.getAbstractFileByPath(finalFilename)) {
            counter++;
            finalFilename = `${targetFolderPath}/${baseFilename}-${counter}.md`;
        }
        
        let fileContent = '---\n';
        fileContent += `title: ${event.title}\n`;
        fileContent += `allDay: ${!!event.allDay}\n`;
        fileContent += `start: ${event.start}\n`; 
        if (event.end) fileContent += `end: ${event.end}\n`;

        if (event.isRecurring) {
            fileContent += `isRecurring: true\n`;
            if (event.daysOfWeek && event.daysOfWeek.length > 0) fileContent += `daysOfWeek: [${event.daysOfWeek.join(',')}]\n`;
            if (event.startRecur) fileContent += `startRecur: ${event.startRecur.substring(0,10)}\n`; 
            if (event.endRecur) fileContent += `endRecur: ${event.endRecur.substring(0,10)}\n`;
        }
        fileContent += '---\n\n';

        try {
            const newFile = await this.app.vault.create(finalFilename, fileContent);
            new Notice(`Event '${event.title}' saved to ${targetFolderPath}.`);
            if (this.calendar) {
                const fcEventData: any = this.formatEventForFullCalendar(newFile.path, event);
                this.calendar.addEvent(fcEventData);
            }
        } catch (e: any) { new Notice(`Error saving event: ${e.message}`); console.error("Error saving event:", e); }
    }
    
    async updateEvent(eventToUpdate: CalendarEvent) {
        if (!eventToUpdate.id) {
            new Notice("Cannot update event: Missing ID (file path).");
            console.error("Update event error: ID missing", eventToUpdate);
            return;
        }

        const originalFilePath = eventToUpdate.id;
        const originalFile = this.app.vault.getAbstractFileByPath(originalFilePath);

        if (!(originalFile instanceof TFile)) {
            new Notice("Error updating event: Original file not found or is not a markdown file.");
            return;
        }

        let finalFilePath = originalFilePath;
        const targetFolderPath = eventToUpdate.targetFolderPath || eventToUpdate.originalFolderPath; // Fallback if target not explicitly changed

        if (!targetFolderPath) {
            new Notice("Error updating event: Target folder path is missing.");
            return;
        }

        // Check if folder needs to change
        const newFileName = `${(eventToUpdate.title || 'Untitled Event').replace(/[\\/:*?"<>|]/g, '')}-${(eventToUpdate.isRecurring && eventToUpdate.startRecur ? eventToUpdate.startRecur : eventToUpdate.start).substring(0,10)}.md`;
        let potentialNewFilePath = `${targetFolderPath}/${newFileName}`;
        
        if (originalFile.parent?.path !== targetFolderPath || originalFile.name !== newFileName) {
            // Ensure target folder exists
            try {
                const folder = this.app.vault.getAbstractFileByPath(targetFolderPath);
                if (!folder) {
                    await this.app.vault.createFolder(targetFolderPath);
                    new Notice(`Created folder: ${targetFolderPath}`);
                } else if (!(folder instanceof TFolder)) {
                    new Notice(`Path ${targetFolderPath} exists but is not a folder. Cannot move event.`);
                    return;
                }
            } catch (e: any) {
                if (!e.message.includes("Folder already exists")) {
                    new Notice(`Error creating/accessing target folder ${targetFolderPath}: ${e.message}`);
                    return;
                }
            }

            // Handle filename conflicts in the new folder
            let counter = 0;
            let tempFileNameForConflictCheck = newFileName;
            while (this.app.vault.getAbstractFileByPath(potentialNewFilePath) && potentialNewFilePath !== originalFilePath) {
                counter++;
                tempFileNameForConflictCheck = `${(eventToUpdate.title || 'Untitled Event').replace(/[\\/:*?"<>|]/g, '')}-${(eventToUpdate.isRecurring && eventToUpdate.startRecur ? eventToUpdate.startRecur : eventToUpdate.start).substring(0,10)}-${counter}.md`;
                potentialNewFilePath = `${targetFolderPath}/${tempFileNameForConflictCheck}`;
            }
            finalFilePath = potentialNewFilePath;

            try {
                if (finalFilePath !== originalFilePath) {
                    await this.app.vault.rename(originalFile, finalFilePath);
                    new Notice(`Event '${eventToUpdate.title}' moved/renamed to ${finalFilePath}.`);
                }
            } catch (e: any) {
                new Notice(`Error moving/renaming event file: ${e.message}`);
                console.error("Error moving/renaming event file:", e);
                return; // Stop if file operation failed
            }
        }

        // Now, modify the content of the (potentially new) file
        const fileToModify = this.app.vault.getAbstractFileByPath(finalFilePath) as TFile;
        if (!fileToModify) {
             new Notice("Error updating event: File not found after potential move/rename.");
             return;
        }

        let fileContent = '---\n';
        fileContent += `title: ${eventToUpdate.title}\n`;
        fileContent += `allDay: ${!!eventToUpdate.allDay}\n`;
        fileContent += `start: ${eventToUpdate.start}\n`;
        if (eventToUpdate.end) fileContent += `end: ${eventToUpdate.end}\n`;
        if (eventToUpdate.isRecurring) {
            fileContent += `isRecurring: true\n`;
            if (eventToUpdate.daysOfWeek && eventToUpdate.daysOfWeek.length > 0) fileContent += `daysOfWeek: [${eventToUpdate.daysOfWeek.join(',')}]\n`;
            if (eventToUpdate.startRecur) fileContent += `startRecur: ${eventToUpdate.startRecur.substring(0,10)}\n`;
            if (eventToUpdate.endRecur) fileContent += `endRecur: ${eventToUpdate.endRecur.substring(0,10)}\n`;
        } else {
            fileContent += `isRecurring: false\n`; 
        }
        fileContent += '---\n\n';

        try {
            await this.app.vault.modify(fileToModify, fileContent);
            if (finalFilePath === originalFilePath) { // Only say updated if not moved
                 new Notice(`Event '${eventToUpdate.title}' updated.`);
            }

            if (this.calendar) {
                let existingFcEvent = this.calendar.getEventById(originalFilePath); // Use original path to find old event
                if (existingFcEvent) existingFcEvent.remove(); 
                
                const fcEventData: any = this.formatEventForFullCalendar(finalFilePath, eventToUpdate); // Use new path for new event
                this.calendar.addEvent(fcEventData);
            }
        } catch (e: any) {
            new Notice(`Error updating event content: ${e.message}`);
            console.error("Error updating event content:", e);
        }
    }

    formatEventForFullCalendar(id: string, event: CalendarEvent): any {
        // Helper function to calculate relative luminance
        const getLuminance = (hexColor: string): number => {
            // Convert hex to RGB
            const r = parseInt(hexColor.slice(1, 3), 16) / 255;
            const g = parseInt(hexColor.slice(3, 5), 16) / 255;
            const b = parseInt(hexColor.slice(5, 7), 16) / 255;
            
            // Calculate relative luminance
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };

        // Determine text color based on background color
        const textColor = event.folderColor ? 
            (getLuminance(event.folderColor) > 0.5 ? '#000000' : '#ffffff') : 
            undefined;

        const fcEventData: any = {
            id: id,
            title: event.title,
            allDay: !!event.allDay,
            backgroundColor: event.folderColor, // Apply folder color
            borderColor: event.folderColor,   // Apply folder color
            textColor: textColor, // Set text color based on background brightness
            extendedProps: {
                ...(event.extendedProps || {}),
                isTodo: false, // Explicitly mark as not a todo
                isRecurring: !!event.isRecurring, 
                daysOfWeek: event.daysOfWeek, 
                startRecur: event.startRecur, 
                endRecur: event.endRecur,
                originalStart: event.start, 
                originalEnd: event.end,
                filePath: id, // Ensure filePath is present for regular events
                folderColor: event.folderColor // Store folderColor in extendedProps too
            }
        };

        if (event.isRecurring) {
            fcEventData.daysOfWeek = event.daysOfWeek;
            // Ensure startRecur/endRecur are just dates for FC
            if (event.startRecur) fcEventData.startRecur = event.startRecur.substring(0,10);
            if (event.endRecur) fcEventData.endRecur = event.endRecur.substring(0,10);

            if (!event.allDay && event.start) {
                const startDate = new Date(event.start);
                fcEventData.startTime = startDate.toTimeString().substring(0,5); // HH:MM
                if (event.end) {
                    const endDate = new Date(event.end);
                    fcEventData.endTime = endDate.toTimeString().substring(0,5); // HH:MM
                }
                // The 'start' property for a recurring event in FC context (when using startRecur/daysOfWeek etc)
                // usually refers to the date of the *first* instance if you want to display it explicitly on that date.
                // Or, it can be omitted if startRecur solely defines the range.
                // For simplicity, let's align with startRecur if available, or the event's main start date.
                fcEventData.start = event.startRecur ? event.startRecur.substring(0,10) : event.start.substring(0,10);
            } else {
                // For all-day recurring, start is still relevant for the first instance date/template
                fcEventData.start = event.startRecur ? event.startRecur.substring(0,10) : event.start.substring(0,10);
            }
            // Store original start/end in extendedProps for the modal when editing a recurring event series template
            fcEventData.extendedProps = { 
                isTodo: false, // Explicitly mark as not a todo
                isRecurring: true, // ensure this flag is on the FC event
                originalStart: event.start, 
                originalEnd: event.end,
                daysOfWeek: event.daysOfWeek, // keep these also in extendedProps for easier retrieval in handleEventClick
                startRecur: event.startRecur,
                endRecur: event.endRecur,
                folderColor: event.folderColor // Ensure folderColor is here too
            };
        } else {
            fcEventData.start = event.start;
            if (event.end) fcEventData.end = event.end;
        }
        return fcEventData;
    }

    async loadEvents(): Promise<any[]> { // Return type any[] for FullCalendar events source
        const { calendarFolderSettings } = this.plugin.settings;
        if (!calendarFolderSettings || calendarFolderSettings.length === 0) {
            console.log("No calendar data folders configured. Cannot load events.");
            if (this.calendar) this.calendar.removeAllEvents(); // Clear calendar if no folders
            return [];
        }

        const allFcEvents: any[] = [];

        for (const folderSetting of calendarFolderSettings) {
            const folderPath = folderSetting.path; // Extract path
            const folderColor = folderSetting.color; // Extract color

            if (!folderPath || folderPath.trim() === '') {
                console.warn("Skipping empty calendar folder path in settings.");
                continue;
            }

            const normalizedPath = folderPath.trim();
            const folder = this.app.vault.getAbstractFileByPath(normalizedPath);

            if (!folder || !(folder instanceof TFolder)) { 
                console.warn(`Calendar data folder "${normalizedPath}" not found or is not a folder.`);
                continue; 
            }

            const files = folder.children.filter(file => file instanceof TFile && file.extension === 'md') as TFile[];
            
            for (const file of files) {
                try {
                    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
                    if (frontmatter && frontmatter.title && frontmatter.start) {
                        // This check might be redundant if 'todos' folders are not typically inside main calendar event folders
                        if (file.path.includes(`/${folderSetting.path}/todos/`)) {
                            continue; 
                        }

                        const eventData: CalendarEvent = {
                            id: file.path, 
                            title: frontmatter.title,
                            start: frontmatter.start,
                            end: frontmatter.end,
                            allDay: frontmatter.allDay === undefined ? !(frontmatter.start?.includes('T')) : frontmatter.allDay,
                            isRecurring: frontmatter.isRecurring || false,
                            daysOfWeek: frontmatter.daysOfWeek,
                            startRecur: frontmatter.startRecur,
                            endRecur: frontmatter.endRecur,
                            originalFolderPath: file.parent?.path,
                            folderColor: folderColor, // Assign folder color to the event
                            extendedProps: { 
                                isRecurring: frontmatter.isRecurring || false,
                                daysOfWeek: frontmatter.daysOfWeek,
                                startRecur: frontmatter.startRecur,
                                endRecur: frontmatter.endRecur,
                                originalStart: frontmatter.start,
                                originalEnd: frontmatter.end,
                                filePath: file.path,
                                folderColor: folderColor // Also add to extendedProps here
                            }
                        };
                        allFcEvents.push(this.formatEventForFullCalendar(file.path, eventData));
                    }
                } catch (e: any) {
                    console.error(`Error processing event file ${file.path}:`, e);
                    new Notice(`Error loading event from ${file.path}.`);
                }
            }
        }

        // Load Todos
        const rawTodos = await this.getRawTodosData();
        for (const todoItem of rawTodos) {
            const { filePath, metadata, folderSetting } = todoItem;

            // Check if it's a recurring task template
            if (metadata.isRecurring && Array.isArray(metadata.daysOfWeek) && metadata.daysOfWeek.length > 0 && (metadata.startRecur || metadata.start)) {
                const startDateString = metadata.startRecur || metadata.start;
                const start = new Date(startDateString);
                start.setHours(0, 0, 0, 0); // Use local time

                // Use calendar's view range for efficiency
                const viewStart = this.calendar ? this.calendar.view.activeStart : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
                const viewEnd = this.calendar ? this.calendar.view.activeEnd : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

                const endRecur = metadata.endRecur ? new Date(metadata.endRecur) : viewEnd;
                endRecur.setHours(23, 59, 59, 999); // Use local time

                let loopStart = start > viewStart ? start : viewStart;
                let loopEnd = endRecur < viewEnd ? endRecur : viewEnd;

                let current = new Date(loopStart);

                // Recurrence pattern logic
                const recurrencePattern = metadata.recurrencePattern || 'weekly';
                // For monthly, determine the week-of-month and day-of-week of the start
                let startWeekOfMonth = null;
                if (recurrencePattern === 'monthly') {
                    const temp = new Date(start);
                    startWeekOfMonth = Math.ceil((temp.getDate() - 1) / 7);
                }

                while (current <= loopEnd) {
                    if (metadata.daysOfWeek.includes(current.getDay())) {
                        let include = false;
                        if (recurrencePattern === 'weekly') {
                            include = true;
                        } else if (recurrencePattern === 'bi-monthly') {
                            // Calculate week number since start
                            const diffDays = Math.floor((current.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                            const weekNum = Math.floor(diffDays / 7);
                            include = (weekNum % 2 === 0);
                        } else if (recurrencePattern === 'monthly') {
                            // Only include if same week-of-month and day-of-week as start
                            const weekOfMonth = Math.ceil((current.getDate() - 1) / 7);
                            include = (weekOfMonth === startWeekOfMonth);
                        }
                        if (include) {
                            const instanceDateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
                            const completedDates = metadata.completedDates || [];
                            const isInstanceCompleted = completedDates.includes(instanceDateStr);
                            const instanceMetadata = {
                                ...metadata,
                                due: instanceDateStr,
                                id: `${filePath}-${instanceDateStr}`,
                                completed: isInstanceCompleted
                            };
                            const formattedTodo = this.formatRawTodoForFullCalendar(filePath, instanceMetadata, folderSetting.color);
                            if (formattedTodo) {
                                allFcEvents.push(formattedTodo);
                            }
                        }
                    }
                    current.setDate(current.getDate() + 1);
                }
            } else if (metadata.due) {
                // It's a non-recurring task with a due date
                const formattedTodo = this.formatRawTodoForFullCalendar(filePath, metadata, folderSetting.color);
                if (formattedTodo) {
                    allFcEvents.push(formattedTodo);
                }
            }
        }

        return allFcEvents;
    }

    async getRawTodosData(): Promise<{ filePath: string, metadata: any, folderSetting: { path: string, color: string } }[]> {
        const todosData: { filePath: string, metadata: any, folderSetting: { path: string, color: string } }[] = [];
        for (const folderSetting of this.plugin.settings.calendarFolderSettings) {
            const todosFolderPath = `${folderSetting.path}/todos`;
            const todosFolder = this.app.vault.getAbstractFileByPath(todosFolderPath);
            if (todosFolder instanceof TFolder) {
                const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(todosFolderPath));
                for (const file of files) {
                    const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
                    if (metadata && metadata.title) {
                        todosData.push({ filePath: file.path, metadata, folderSetting });
                    }
                }
            }
        }
        return todosData;
    }

    formatRawTodoForFullCalendar(filePath: string, metadata: any, folderColor?: string): any {
        if (!metadata.due) {
            return null;
        }

        const startDateTime = metadata.due + (metadata.dueTime ? `T${metadata.dueTime}` : '');
        const allDay = !metadata.dueTime;

        return {
            id: metadata.id || filePath,
            title: metadata.title,
            start: startDateTime,
            allDay: allDay,
            backgroundColor: 'var(--background-primary)',
            borderColor: 'var(--background-modifier-border)',
            textColor: 'var(--text-normal)',
            classNames: [
                'fc-event-is-todo',
                ...(metadata.completed ? ['fc-event-todo-completed'] : []),
            ],
            editable: true,
            eventDurationEditable: false,
            extendedProps: {
                ...metadata,
                isTodo: true,
                filePath: filePath,
                completed: !!metadata.completed,
                originalColor: folderColor || 'var(--interactive-accent)',
            }
        };
    }

    toggleTasksSidebar() {
        if (!this.tasksSidebar) return;
    
        this.isTasksSidebarOpen = !this.isTasksSidebarOpen;
    
        const isSidebarLeft = this.plugin.settings.taskSidebarPosition === 'left';
        const calendarContainer = document.getElementById('calendar-container');
    
        if (this.isTasksSidebarOpen) {
            this.tasksSidebar.style.transform = 'translateX(0)';
            if (calendarContainer) {
                calendarContainer.style.width = `calc(100% - 300px)`;
                calendarContainer.style.marginLeft = isSidebarLeft ? '300px' : '0';
                calendarContainer.style.marginRight = isSidebarLeft ? '0' : '300px';
            }
        } else { // Closing
            this.tasksSidebar.style.transform = `translateX(${isSidebarLeft ? '-100%' : '100%'})`;
            if (calendarContainer) {
                calendarContainer.style.width = '100%';
                calendarContainer.style.marginLeft = '0';
                calendarContainer.style.marginRight = '0';
            }
        }
    
        // Force calendar to update its layout
        if (this.calendar) {
            // Update size immediately
            this.calendar.updateSize();
    
            // Update size again after a short delay to ensure proper rendering
            setTimeout(() => {
                this.calendar?.updateSize();
            }, 50);
        }
    }

    async onClose() {
        if (this.calendar) {
            this.calendar.destroy();
            this.calendar = null;
        }
        const container = this.containerEl.children[1];
        if (container) {
            container.empty();
        }
        if (this.sidebarRefreshInterval) {
            clearInterval(this.sidebarRefreshInterval);
            this.sidebarRefreshInterval = null;
        }
    }

    // Proper class method for loading and rendering tasks
    async loadAndRenderTasks(container: HTMLElement, folderFilter: string = '', dueFilter: string = '', importanceFilter: string = '') {
        container.empty();
        const tasks: { file: TFile, metadata: any }[] = [];
        // Load tasks from all todos subfolders
        for (const folder of this.plugin.settings.calendarFolderSettings) {
            const todosFolderPath = `${folder.path}/todos`;
            const todosFolder = this.app.vault.getAbstractFileByPath(todosFolderPath);
            if (todosFolder instanceof TFolder) {
                const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(todosFolderPath));
                for (const file of files) {
                    const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
                    if (metadata) {
                        // Recurring logic for sidebar
                        if (metadata.isRecurring && Array.isArray(metadata.daysOfWeek) && metadata.startRecur) {
                            // Expand for each matching day in the next 30 days
                            const start = new Date(metadata.startRecur);
                            const end = metadata.endRecur ? new Date(metadata.endRecur) : new Date(Date.now() + 1000*60*60*24*30);
                            let current = new Date(Math.max(start.getTime(), Date.now() - (24 * 60 * 60 * 1000))); // Also show today's
                            for (let i = 0; i < 30; i++) {
                                if (current > end) break;
                                if (metadata.daysOfWeek.includes(current.getDay())) {
                                    const completedDates = metadata.completedDates || [];
                                    // Use local date string for due date
                                    const instanceDate = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
                                    const isCompleted = completedDates.includes(instanceDate);

                                    if (isCompleted && !this.plugin.settings.showCompletedInSidebar) {
                                        // continue;
                                    } else {
                                        const instanceMeta = { ...metadata, due: instanceDate, completed: isCompleted };
                                        tasks.push({ file, metadata: instanceMeta });
                                    }
                                }
                                current.setDate(current.getDate() + 1);
                            }
                        } else {
                            // Apply folder filter
                            if (folderFilter && !file.path.startsWith(folderFilter + '/todos')) continue;
                            // Apply due date filter
                            if (dueFilter) {
                                const dateString = metadata.due;
                                const dueDateUtc = new Date(dateString + "T00:00:00.000Z");
                                const today = new Date();
                                const todayUtcMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
                                let isOverdue = false;
                                let dueDisplay = '';
                                try {
                                    isOverdue = dueDateUtc.getTime() < todayUtcMidnight.getTime();
                                    const msPerDay = 1000 * 60 * 60 * 24;
                                    const diffDays = Math.floor((dueDateUtc.getTime() - todayUtcMidnight.getTime()) / msPerDay);
                                    if (diffDays >= 0 && diffDays < 7) {
                                        const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                                        dueDisplay = daysOfWeek[dueDateUtc.getUTCDay()];
                                    } else {
                                        const dd = String(dueDateUtc.getUTCDate()).padStart(2, '0');
                                        const mm = String(dueDateUtc.getUTCMonth() + 1).padStart(2, '0');
                                        dueDisplay = `${dd}/${mm}`;
                                    }
                                } catch (e) {
                                    dueDisplay = metadata.due; // Fallback
                                }
                                if (isOverdue) continue;
                            } else if (dueFilter === 'none') {
                                if (metadata.due) continue;
                            }
                            // Apply importance filter
                            if (importanceFilter) {
                                const priority = (metadata.priority || 'none').toLowerCase();
                                if (importanceFilter !== priority) continue;
                            }
                            // Filter out completed tasks if the setting is off
                            if (!this.plugin.settings.showCompletedInSidebar && metadata.completed) continue;
                            tasks.push({ file, metadata });
                        }
                    }
                }
            }
        }
        // Sort tasks by due date, then by completed status (completed always at the bottom)
        tasks.sort((a, b) => {
            // Completed tasks always at the bottom
            const aCompleted = !!a.metadata.completed;
            const bCompleted = !!b.metadata.completed;
            if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
            // Sort by importance if filter is set
            if (importanceFilter) {
                const priorityOrder: Record<string, number> = { high: 1, medium: 2, low: 3, none: 4 };
                const aKey = ((a.metadata.priority || 'none').toLowerCase() as keyof typeof priorityOrder);
                const bKey = ((b.metadata.priority || 'none').toLowerCase() as keyof typeof priorityOrder);
                const aPriority = priorityOrder[aKey] ?? 4;
                const bPriority = priorityOrder[bKey] ?? 4;
                if (aPriority !== bPriority) return aPriority - bPriority;
            }
            // Then sort by due date
            if (!a.metadata.due) return 1;
            if (!b.metadata.due) return -1;
            const aDate = new Date(a.metadata.due);
            const bDate = new Date(b.metadata.due);
            aDate.setHours(0,0,0,0);
            bDate.setHours(0,0,0,0);
            if (aDate.getTime() !== bDate.getTime()) {
                return aDate.getTime() - bDate.getTime();
            }
            // If same day, sort by due time (earlier first, missing dueTime is latest)
            const aTime = a.metadata.dueTime ? a.metadata.dueTime.split(':').map(Number) : [23, 59];
            const bTime = b.metadata.dueTime ? b.metadata.dueTime.split(':').map(Number) : [23, 59];
            if (aTime[0] !== bTime[0]) return aTime[0] - bTime[0];
            if (aTime[1] !== bTime[1]) return aTime[1] - bTime[1];
            return 0;
        });

        // --- Accordion Section Logic ---
        const today = new Date();
        today.setHours(0,0,0,0);
        const weekEnd = new Date(today);
        weekEnd.setDate(today.getDate() + 6); // 7 days from today (inclusive)

        const dueToday: typeof tasks = [];
        const dueThisWeek: typeof tasks = [];
        const dueLater: typeof tasks = [];

        for (const task of tasks) {
            if (!task.metadata.due) {
                dueLater.push(task);
                continue;
            }
            // Parse due date as local date
            const [year, month, day] = String(task.metadata.due).split('-').map(Number);
            const dueDate = new Date(year, month - 1, day);
            dueDate.setHours(0,0,0,0);
            if (dueDate.getTime() === today.getTime()) {
                dueToday.push(task);
            } else if (dueDate.getTime() > today.getTime() && dueDate.getTime() <= weekEnd.getTime()) {
                dueThisWeek.push(task);
            } else {
                dueLater.push(task);
            }
        }

        // Accordion state (persistent)
        const openSections = this.sidebarOpenSections;

        function renderAccordionSection(this: CalendarView, title: string, sectionKey: keyof typeof openSections, sectionTasks: typeof tasks) {
            const section = container.createDiv({ cls: 'obby-tasks-accordion-section' });
            const header = section.createDiv({ cls: 'obby-tasks-accordion-header', attr: { style: 'cursor: pointer; font-weight: bold; font-size: 1.05em; padding: 6px 0; display: flex; align-items: center;' } });
            const arrow = header.createSpan({ text: openSections[sectionKey] ? '▼' : '▶', attr: { style: 'margin-right: 8px; font-size: 1.1em;' } });
            header.createSpan({ text: title });
            header.onclick = () => {
                this.sidebarOpenSections[sectionKey] = !this.sidebarOpenSections[sectionKey];
                arrow.textContent = this.sidebarOpenSections[sectionKey] ? '▼' : '▶';
                content.style.display = this.sidebarOpenSections[sectionKey] ? '' : 'none';
            };
            const content = section.createDiv({ cls: 'obby-tasks-accordion-content' });
            content.style.display = this.sidebarOpenSections[sectionKey] ? '' : 'none';
            for (const task of sectionTasks) {
                // Render each task as before
                // --- Begin task rendering ---
                const taskItem = content.createDiv({
                    cls: 'task-item',
                    attr: {
                        style: 'display: flex; align-items: center; padding: 8px; margin-bottom: 4px; border-radius: 4px; cursor: pointer;'
                    }
                });
                taskItem.addEventListener('mouseover', () => {
                    taskItem.style.backgroundColor = 'var(--background-secondary)';
                });
                taskItem.addEventListener('mouseout', () => {
                    taskItem.style.backgroundColor = '';
                });
                taskItem.addEventListener('click', () => {
                    const folder = task.file.path.split('/')[0];
                    new TaskModal(
                        this.app,
                        this.plugin,
                        this.plugin.settings.calendarFolderSettings.map((f: any) => f.path),
                        () => {
                            this.loadAndRenderTasks(container, folderFilter, dueFilter, importanceFilter);
                            if (this.calendar) { this.calendar.refetchEvents(); }
                        },
                        task.file.path,
                        {
                            title: task.metadata.title,
                            description: task.metadata.description,
                            due: task.metadata.due,
                            dueTime: task.metadata.dueTime,
                            priority: task.metadata.priority,
                            folder: folder,
                            isRecurring: task.metadata.isRecurring,
                            daysOfWeek: task.metadata.daysOfWeek,
                            startRecur: task.metadata.startRecur,
                            endRecur: task.metadata.endRecur
                        }
                    ).open();
                });
                const checkbox = taskItem.createEl('input', { type: 'checkbox', attr: { style: 'margin-right: 8px; flex-shrink: 0;' } });
                checkbox.checked = !!task.metadata.completed;
                checkbox.addEventListener('click', async (e) => {
                    e.stopPropagation(); // Prevent triggering the edit modal
                    const newCompletedStatus = !task.metadata.completed;
                    try {
                        if (task.metadata.isRecurring) {
                            await this.updateRecurringTodoCompletion(task.file.path, task.metadata.due, newCompletedStatus);
                        } else {
                            await this.updateTodoCompletionInFile(task.file.path, newCompletedStatus);
                        }
                        setTimeout(() => {
                            if (this.calendar) this.calendar.refetchEvents();
                            if (this.taskListEl) {
                                this.loadAndRenderTasks(this.taskListEl, folderFilter, dueFilter, importanceFilter);
                            }
                        }, 150);
                    } catch (error) {
                        new Notice(`Error updating task: ${error.message}`);
                        checkbox.checked = !newCompletedStatus;
                    }
                });
                const folder = task.file.path.split('/')[0];
                const folderSettings = this.plugin.settings.calendarFolderSettings.find((f: any) => f.path === folder);
                if (folderSettings) {
                    taskItem.style.borderLeft = `5px solid ${folderSettings.color}`;
                } else {
                    taskItem.style.borderLeft = '5px solid transparent';
                }
                const textContainer = taskItem.createDiv({
                    attr: { style: 'flex-grow: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center;' }
                });
                textContainer.createDiv({
                    text: task.metadata.title,
                    attr: {
                        style: `font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: var(--obby-task-max-width, 90px); line-height: 1.2; min-width: 0; flex-shrink: 1;${task.metadata.completed ? ' text-decoration: line-through; color: var(--text-muted);' : ''}`
                    }
                });
                if (task.metadata.description) {
                    textContainer.createDiv({
                        text: String(task.metadata.description).replace(/\n/g, ' ').slice(0, 80),
                        attr: {
                            style: `font-size: 0.85em; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: var(--obby-task-max-width, 110px);${task.metadata.completed ? ' text-decoration: line-through;' : ''}`
                        }
                    });
                }
                if (task.metadata.due) {
                    let isOverdue = false;
                    let dueDisplay = '';
                    try {
                        const rawDueDateValue = task.metadata.due;
                        if (rawDueDateValue) {
                            const rawDueDateString = String(rawDueDateValue);
                            if (/^\d{4}-\d{2}-\d{2}/.test(rawDueDateString)) {
                                const datePart = rawDueDateString.substring(0, 10);
                                const [year, monthNum, dayNum] = datePart.split('-').map(Number);
                                const dueDateUtc = new Date(Date.UTC(year, monthNum - 1, dayNum));
                                const today = new Date();
                                const todayUtcMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
                                isOverdue = dueDateUtc.getTime() < todayUtcMidnight.getTime();
                                const msPerDay = 1000 * 60 * 60 * 24;
                                const diffDays = Math.floor((dueDateUtc.getTime() - todayUtcMidnight.getTime()) / msPerDay);
                                if (diffDays >= 0 && diffDays < 7) {
                                    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                                    dueDisplay = daysOfWeek[dueDateUtc.getUTCDay()];
                                } else {
                                    const dd = String(dueDateUtc.getUTCDate()).padStart(2, '0');
                                    const mm = String(dueDateUtc.getUTCMonth() + 1).padStart(2, '0');
                                    dueDisplay = `${dd}/${mm}`;
                                }
                            } else {
                                const tempDate = new Date(rawDueDateString);
                                if (!isNaN(tempDate.getTime())) {
                                     const dd = String(tempDate.getDate()).padStart(2, '0');
                                     const mm = String(tempDate.getMonth() + 1).padStart(2, '0');
                                     dueDisplay = `${dd}/${mm}*`;
                                } else {
                                    dueDisplay = 'Invalid Date';
                                }
                            }
                        } else {
                            dueDisplay = '';
                        }
                    } catch (e) {
                        dueDisplay = String(task.metadata.due || '');
                    }
                    const dueContainer = taskItem.createDiv({
                        attr: {
                            style: 'display: flex; flex-direction: column; align-items: center; margin-left: 8px; min-width: 36px; max-width: 48px;'
                        }
                    });
                    dueContainer.createDiv({
                        text: dueDisplay,
                        attr: {
                            style: `font-size: 0.85em; color: ${isOverdue ? 'var(--text-error)' : 'var(--text-muted)'}; border: 1px solid var(--background-modifier-border); border-radius: 6px; background: var(--background-secondary); padding: 2px 6px; box-sizing: border-box; width: 100%; text-align: center;`
                        }
                    });
                    if (task.metadata.dueTime) {
                        dueContainer.createDiv({
                            text: task.metadata.dueTime,
                            attr: {
                                style: 'font-size: 0.8em; color: var(--text-faint); width: 100%; text-align: center; margin-top: 2px;'
                            }
                        });
                    }
                }
                // --- End task rendering ---
            }
        }

        renderAccordionSection.call(this, 'Due Today', 'today', dueToday);
        renderAccordionSection.call(this, 'Due This Week', 'week', dueThisWeek);
        renderAccordionSection.call(this, 'All Other Tasks', 'later', dueLater);
    }

    // Proper class method for getting all todos
    async getAllTodos(): Promise<{ title: string, folder?: string, due?: string }[]> {
        const allTasks: { title: string, folder?: string, due?: string }[] = [];
        for (const folderSetting of this.plugin.settings.calendarFolderSettings) {
            const todosPath = `${folderSetting.path}/todos`;
            const todosFolder = this.app.vault.getAbstractFileByPath(todosPath);
            if (todosFolder && todosFolder instanceof TFolder) {
                for (const file of todosFolder.children) {
                    if (file instanceof TFile && file.extension === 'md') {
                        const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
                        if (meta && meta.title) {
                            allTasks.push({ title: meta.title, folder: folderSetting.path, due: meta.due });
                        }
                    }
                }
            }
        }
        return allTasks;
    }

    // --- Step 3: Add helper for updating todo completion ---
    async updateTodoCompletionInFile(filePath: string, completed: boolean) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            try {
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    fm.completed = completed;
                });
                new Notice(`Todo ${completed ? 'marked as complete' : 'marked as incomplete'}.`);
            } catch (error) {
                console.error("Error updating todo completion:", error);
                throw new Error('Failed to update todo completion status in file.');
            }
        } else {
            throw new Error('Todo file not found for completion update.');
        }
    }
    // --- End Step 3 ---

    // --- New method for recurring todo completion ---
    async updateRecurringTodoCompletion(filePath: string, instanceDate: string, completed: boolean) {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            new Notice("Error: Could not find original task file.");
            return;
        }

        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                let completedDates = fm.completedDates || [];
                if (!Array.isArray(completedDates)) {
                    completedDates = [];
                }

                const dateExists = completedDates.includes(instanceDate);

                if (completed && !dateExists) {
                    completedDates.push(instanceDate);
                } else if (!completed && dateExists) {
                    completedDates = completedDates.filter((d: string) => d !== instanceDate);
                }
                fm.completedDates = completedDates;
                delete fm.completed; // Remove the old global completed flag
            });
            new Notice(`Task for ${instanceDate} ${completed ? 'marked as complete' : 'marked as incomplete'}.`);
        } catch (error) {
            console.error("Error updating recurring todo completion:", error);
            throw new Error('Failed to update recurring todo completion status in file.');
        }
    }

    // --- Step 5: Add handler for when a todo is dropped ---
    async handleTodoDrop(dropInfo: any) {
        const { event, oldEvent, revert } = dropInfo;
        const filePath = event.extendedProps.filePath;

        if (!filePath) {
            new Notice("Error: Todo file path not found.");
            revert();
            return;
        }

        const newStart: Date | null = event.start;
        const newAllDay: boolean = event.allDay;

        if (!newStart) {
            new Notice("Error: Invalid drop location for todo.");
            revert();
            return;
        }

        try {
            await this.app.fileManager.processFrontMatter(this.app.vault.getAbstractFileByPath(filePath) as TFile, (fm) => {
                fm.due = newStart.toISOString().split('T')[0]; // YYYY-MM-DD
                if (!newAllDay && newStart) {
                    // Get time in HH:MM format from the newStart date
                    const hours = newStart.getHours().toString().padStart(2, '0');
                    const minutes = newStart.getMinutes().toString().padStart(2, '0');
                    fm.dueTime = `${hours}:${minutes}`;
                } else {
                    delete fm.dueTime; // Remove dueTime if it becomes an all-day event
                }
                // Preserve completion status
                if (event.extendedProps.completed !== undefined) {
                    fm.completed = event.extendedProps.completed;
                } else if (oldEvent.extendedProps.completed !== undefined) {
                     fm.completed = oldEvent.extendedProps.completed;
                } else {
                    fm.completed = false; // Default if somehow not set
                }
            });
            new Notice(`Todo "${event.title}" updated.`);
            if (this.calendar) {
                this.calendar.refetchEvents();
            }
        } catch (error) {
            console.error("Error updating todo on drop:", error);
            new Notice("Failed to update todo. Reverting change.");
            revert();
        }
    }
    // --- End Step 5 ---

    // Add this method to allow live updating of sidebar position
    public updateSidebarPosition() {
        if (!this.tasksSidebar) return;
        const isSidebarLeft = this.plugin.settings.taskSidebarPosition === 'left';
        // Update border
        this.tasksSidebar.style.borderLeft = '';
        this.tasksSidebar.style.borderRight = '';
        this.tasksSidebar.style[`border${isSidebarLeft ? 'Right' : 'Left'}`] = '1px solid var(--background-modifier-border)';
        this.tasksSidebar.style[`border${isSidebarLeft ? 'Left' : 'Right'}`] = '';
        // Update margin for open/closed state
        if (this.isTasksSidebarOpen) {
            this.tasksSidebar.style.marginLeft = isSidebarLeft ? '0' : '';
            this.tasksSidebar.style.marginRight = isSidebarLeft ? '' : '0';
        } else {
            this.tasksSidebar.style.marginLeft = isSidebarLeft ? '-300px' : '';
            this.tasksSidebar.style.marginRight = isSidebarLeft ? '' : '-300px';
        }
        // Update calendar container layout
        const calendarContainer = document.getElementById('calendar-container');
        if (calendarContainer) {
            calendarContainer.style.width = this.isTasksSidebarOpen ? 'calc(100% - 300px)' : '100%';
            calendarContainer.style.marginLeft = '0';
            calendarContainer.style.marginRight = '0';
        }
        // Force calendar to update its layout
        if (this.calendar) {
            this.calendar.updateSize();
            setTimeout(() => {
                this.calendar?.updateSize();
            }, 50);
        }
    }
}

class EventModal extends Modal {
    plugin: MyPlugin;
    result: Partial<CalendarEvent>; 
    onSubmit: (result: CalendarEvent) => void;
    isEditMode: boolean;
    daysOfWeekMap = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    availableCalendarFolders: string[];
    private selectedFolderTextEl: HTMLSpanElement | null = null; 

    constructor(app: App, plugin: MyPlugin, onSubmit: (result: CalendarEvent) => void, 
                availableFolders: string[],
                existingEvent?: CalendarEvent, 
                startStrRaw?: string, 
                endStrRaw?: string, 
                allDayVal?: boolean,
                isEditModeFlag?: boolean 
            ) {
        super(app);
        this.plugin = plugin;
        this.onSubmit = onSubmit;
        this.availableCalendarFolders = availableFolders.filter(f => f && f.trim() !== '');
        this.isEditMode = isEditModeFlag ?? !!existingEvent;

        if (existingEvent) {
            this.result = { ...existingEvent }; 
            if (!this.result.originalFolderPath && this.result.id) {
                const file = this.app.vault.getAbstractFileByPath(this.result.id) as TFile;
                this.result.originalFolderPath = file?.parent?.path;
            }
            this.result.targetFolderPath = this.result.originalFolderPath;

            if (this.result.isRecurring && this.result.fcEvent?.extendedProps.originalStart) {
                this.result.start = this.result.fcEvent.extendedProps.originalStart;
                this.result.end = this.result.fcEvent.extendedProps.originalEnd;
            } 
            this.formatResultTimesForDisplay();
        } else {
            let initialStart = startStrRaw;
            let initialEnd = endStrRaw;
            if (allDayVal && initialStart && initialEnd) { 
                const startDate = new Date(initialStart);
                const endDate = new Date(initialEnd);
                if (endDate.getTime() === new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1).getTime()) {
                    initialEnd = undefined;
                }
            }
            if (!allDayVal && initialStart && initialEnd && initialStart === initialEnd) initialEnd = undefined;

            this.result = { 
                title: '', 
                start: initialStart, 
                end: initialEnd, 
                allDay: allDayVal !== undefined ? allDayVal : true, 
                isRecurring: false, 
                daysOfWeek: [], 
                startRecur: initialStart?.substring(0,10), 
                endRecur: '', 
                targetFolderPath: this.availableCalendarFolders.length > 0 ? this.availableCalendarFolders[0] : undefined
            }; 
            if (!this.result.start) this.result.start = new Date().toISOString();
            if (!this.result.startRecur && this.result.start) this.result.startRecur = this.result.start.substring(0,10);
            this.formatResultTimesForDisplay();
        }
    }

    formatResultTimesForDisplay() {
        if (this.result.allDay) {
            if (this.result.start) this.result.start = this.result.start.substring(0, 10);
            if (this.result.end) this.result.end = this.result.end.substring(0, 10);
        } else {
            if (this.result.start) this.result.start = this.result.start.includes('T') ? this.result.start.substring(0, 16) : this.result.start.substring(0,10) + 'T09:00';
            if (this.result.end) this.result.end = this.result.end.includes('T') ? this.result.end.substring(0, 16) : this.result.end.substring(0,10) + 'T10:00';
        }
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.empty();
        contentEl.createEl('h2', {text: this.isEditMode ? 'Edit Event' : 'Create New Event'});

        const folderSetting = new Setting(contentEl)
            .setName('Calendar Folder')
            .setDesc(this.isEditMode ? "Select which calendar this event belongs to:" : "Select which calendar to save this event to:");

        folderSetting.addDropdown(dropdown => {
            // Add each folder as an option
            this.availableCalendarFolders.forEach(folder => {
                dropdown.addOption(folder, folder);
            });
            
            // Set the current value
            if (this.result.targetFolderPath) {
                dropdown.setValue(this.result.targetFolderPath);
            } else if (this.availableCalendarFolders.length > 0) {
                dropdown.setValue(this.availableCalendarFolders[0]);
                this.result.targetFolderPath = this.availableCalendarFolders[0];
            }

            // Handle changes
            dropdown.onChange(value => {
                this.result.targetFolderPath = value;
            });
        });
        
        if (this.availableCalendarFolders.length === 0) {
            folderSetting.controlEl.createEl('p', {
                text: 'No folders configured in settings.',
                cls: 'mod-warning'
            });
        }
       
        new Setting(contentEl)
            .setName('Event Title')
            .setDesc('The name of the event.')
            .addText(text => text
                .setPlaceholder('New Event')
                .setValue(this.result.title || '')
                .onChange(value => this.result.title = value));
        
        new Setting(contentEl)
            .setName('All Day Event')
            .addToggle(toggle => toggle
                .setValue(!!this.result.allDay)
                .onChange(value => {
                    this.result.allDay = value;
                    this.formatResultTimesForDisplay(); 
                    this.onOpen(); 
                }));

        const startSettingName = this.result.isRecurring ? 'Template Start' : 'Start';
        let startSettingDesc = this.result.allDay ? "Date the event starts." : "Date and time the event starts.";
        if (this.result.isRecurring && !this.result.allDay) {
        }
        const startSetting = new Setting(contentEl)
            .setName(this.result.allDay ? `${startSettingName} Date` : `${startSettingName} Date/Time`)
            .setDesc(startSettingDesc);
        startSetting.addText(textEl => {
            textEl.inputEl.type = this.result.allDay ? 'date' : 'datetime-local';
            textEl.setValue(this.result.start || '')
                .onChange(value => { 
                    this.result.start = value; 
                    this.updateRecurrenceStartDefault(); 
                });
        });

        const endSettingName = this.result.isRecurring ? 'Template End' : 'End';
        const endSettingDesc = this.result.allDay ? "Date the event ends (optional)." : "Date and time the event ends (optional).";
        const endSetting = new Setting(contentEl)
            .setName(this.result.allDay ? `${endSettingName} Date` : `${endSettingName} Date/Time`)
            .setDesc(endSettingDesc);
        endSetting.addText(textEl => {
            textEl.inputEl.type = this.result.allDay ? 'date' : 'datetime-local';
            textEl.setValue(this.result.end || '')
                .onChange(value => this.result.end = value || undefined);
        });
        if (this.result.allDay && (!this.result.end || this.result.start === this.result.end)) {
            if (!this.isEditMode && (!this.result.end || this.result.end === this.result.start?.substring(0,10))){
            } 
        } 

        contentEl.createEl('hr');
        contentEl.createEl('h4', { text: 'Recurrence Settings' });

        new Setting(contentEl)
            .setName("Enable Recurrence")
            .addToggle(toggle => {
                toggle.setValue(!!this.result.isRecurring)
                    .onChange(value => {
                        this.result.isRecurring = value;
                        if (value && !this.result.startRecur && this.result.start) { 
                            this.result.startRecur = this.result.start.substring(0,10);
                        }
                        this.onOpen(); 
                    });
            });

        if (this.result.isRecurring) {
            new Setting(contentEl)
                .setName("Recurrence Start Date")
                .setDesc("Date the recurrence pattern begins.")
                .addText(text => text
                    .setPlaceholder("YYYY-MM-DD")
                    .setValue(this.result.startRecur || (this.result.start?.substring(0,10) || ''))
                    .onChange(value => this.result.startRecur = value));

            // Days of week
            const daysOfWeekArr = this.result.daysOfWeek ?? [];
            const daysOuterSetting = new Setting(contentEl)
                .setName("Repeat on Days")
                .setDesc("Select days for weekly recurrence.");
            const daysGrid = daysOuterSetting.controlEl.createDiv({
                cls: 'obby-days-checkboxes-grid',
                attr: { style: 'display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 18px; margin-top: 10px; margin-bottom: 10px; align-items: center;' }
            });
            this.daysOfWeekMap.forEach((dayName, index) => {
                const cell = daysGrid.createDiv({ attr: { style: 'display: flex; align-items: center;' } });
                const checkboxId = `task-day-checkbox-${index}`;
                const checkbox = cell.createEl('input', {
                    type: 'checkbox',
                    attr: { id: checkboxId, style: 'margin-right: 6px;' }
                });
                checkbox.checked = daysOfWeekArr.includes(index);
                checkbox.onchange = (event) => {
                    if (!this.result.daysOfWeek) this.result.daysOfWeek = [];
                    const checked = (event.target as HTMLInputElement).checked;
                    if (checked) {
                        if (!this.result.daysOfWeek.includes(index)) this.result.daysOfWeek.push(index);
                    } else {
                        this.result.daysOfWeek = this.result.daysOfWeek.filter((d: number) => d !== index);
                    }
                    this.result.daysOfWeek.sort((a: number, b: number) => a - b);
                };
                cell.createEl('label', { text: dayName, attr: { for: checkboxId, style: 'font-size: 1em; font-weight: 400;' } });
            });
            // End date
            new Setting(contentEl)
                .setName("End Recurrence (Optional)")
                .addText(text => text
                    .setPlaceholder("YYYY-MM-DD")
                    .setValue(this.result.endRecur || '')
                    .onChange(value => this.result.endRecur = value || ''));
        }
        contentEl.createEl('hr');

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';
        buttonContainer.style.marginTop = '20px';

        if (this.isEditMode) {
            const deleteButton = new ButtonComponent(buttonContainer) 
                .setButtonText('Delete Event')
                .setWarning()
                .onClick(async () => {
                    if (confirm('Are you sure you want to delete this event?')) {
                        if (this.result.id) {
                            await this.plugin.deleteEventFile(this.result.id); 
                            if (this.plugin.calendarView?.calendar) {
                                const fcEvent = this.plugin.calendarView.calendar.getEventById(this.result.id);
                                if (fcEvent) fcEvent.remove();
                            }
                            new Notice('Event deleted.');
                            this.close();
                        } else { new Notice('Cannot delete: Event ID not found.'); }
                    }
                });
        }

        const saveButton = new ButtonComponent(buttonContainer) 
            .setButtonText(this.isEditMode ? 'Update Event' : 'Save Event') 
            .setCta()
            .onClick(() => {
                if (!this.result.targetFolderPath || this.result.targetFolderPath.trim() === '') {
                    new Notice("Please select a calendar folder or configure one in settings.");
                     return;
                }

                if (!this.result.title) this.result.title = "Untitled Event";
                if (!this.result.start) { new Notice("Event start cannot be empty."); return; }
                if (this.result.isRecurring && (!this.result.startRecur || (this.result.daysOfWeek && this.result.daysOfWeek.length === 0) )) {
                    new Notice("For recurring events, set recurrence start date and select at least one day of the week."); return; 
                }
                const finalEvent: CalendarEvent = { ...this.result } as CalendarEvent;
                if (finalEvent.allDay) {
                    if (finalEvent.start) finalEvent.start = finalEvent.start.substring(0,10);
                    if (finalEvent.end) finalEvent.end = finalEvent.end.substring(0,10);
                    if (finalEvent.start === finalEvent.end) finalEvent.end = undefined;
                } else {
                    if (finalEvent.start && finalEvent.start.length === 16) finalEvent.start += ':00';
                    if (finalEvent.end && finalEvent.end.length === 16) finalEvent.end += ':00';
                }
                if (finalEvent.isRecurring) {
                    if (finalEvent.startRecur) finalEvent.startRecur = finalEvent.startRecur.substring(0,10);
                    if (finalEvent.endRecur) finalEvent.endRecur = finalEvent.endRecur.substring(0,10);
                }

                this.onSubmit(finalEvent);
                this.close();
            });
    }

    updateRecurrenceStartDefault() {
        if (this.result.isRecurring && this.result.start) {
            const eventStartDate = this.result.start.substring(0,10);
            if (!this.result.startRecur || this.result.startRecur < eventStartDate) {
                this.result.startRecur = eventStartDate;
            }
        }
    }
    onClose() { 
        let {contentEl} = this; contentEl.empty(); 
    }
} 

// Suggest Modal for selecting a folder
export class FolderSuggestModal extends SuggestModal<string> {
    plugin: MyPlugin;
    onChoose: (folderPath: string) => void;
    availableFolders: string[];

    constructor(app: App, plugin: MyPlugin, availableFolders: string[], onChoose: (folderPath: string) => void) {
        super(app);
        this.plugin = plugin;
        this.availableFolders = availableFolders.filter(f => f && f.trim() !== '');
        this.onChoose = onChoose;
    }

    onOpen() {
        super.onOpen(); 
        this.inputEl.placeholder = "Select or type to find a calendar folder...";
    }

    getSuggestions(query: string): string[] {
        const lcQuery = query.toLowerCase();
        return this.availableFolders.filter(folder => 
            folder.toLowerCase().includes(lcQuery)
        );
    }

    renderSuggestion(folderPath: string, el: HTMLElement) {
        el.createEl("div", { text: folderPath });
    }

    onChooseSuggestion(folderPath: string, evt: MouseEvent | KeyboardEvent) {
        this.onChoose(folderPath);
        this.close();
    }
} 

// TaskModal for creating a new todo
class TaskModal extends Modal {
    plugin: MyPlugin;
    onSubmit: () => void;
    calendarFolders: string[];
    filePath?: string; // Add filePath to track the task being edited
    existingTask?: { title: string, description?: string, due?: string, dueTime?: string, priority?: string, folder?: string, isRecurring?: boolean, daysOfWeek?: number[], startRecur?: string, endRecur?: string };
    // Recurrence state
    isRecurring: boolean = false;
    daysOfWeek: number[] = [];
    startRecur: string = '';
    endRecur: string = '';

    daysOfWeekMap = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    constructor(app: App, plugin: MyPlugin, calendarFolders: string[], onSubmit: () => void, filePath?: string, existingTask?: { title: string, description?: string, due?: string, dueTime?: string, priority?: string, folder?: string, isRecurring?: boolean, daysOfWeek?: number[], startRecur?: string, endRecur?: string }) {
        super(app);
        this.plugin = plugin;
        this.calendarFolders = calendarFolders;
        this.onSubmit = onSubmit;
        this.filePath = filePath;
        this.existingTask = existingTask;
        // Load recurrence if editing
        if (existingTask) {
            this.isRecurring = !!existingTask.isRecurring;
            this.daysOfWeek = existingTask.daysOfWeek || [];
            this.startRecur = existingTask.startRecur || '';
            this.endRecur = existingTask.endRecur || '';
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: this.filePath ? 'Edit Todo' : 'Add New Todo' });

        // Title
        const titleInput = contentEl.createEl('input', { type: 'text', attr: { placeholder: 'Task title', style: 'width: 100%; margin-bottom: 8px;' } });
        if (this.existingTask?.title) titleInput.value = this.existingTask.title;

        // Description
        const descInput = contentEl.createEl('textarea', { attr: { placeholder: 'Description', style: 'width: 100%; margin-bottom: 8px; min-height: 40px;' } });
        if (this.existingTask?.description) descInput.value = this.existingTask.description;

        // Date field (Due Date or Start Date)
        const dateLabel = contentEl.createEl('span', { text: this.isRecurring ? 'Start Date' : 'Due Date' });
        const dateInput = contentEl.createEl('input', { type: 'date', attr: { style: 'width: 100%; margin-bottom: 8px;' } });
        if (this.isRecurring) {
            dateInput.value = this.startRecur || this.existingTask?.startRecur || '';
        } else {
            dateInput.value = this.existingTask?.due || '';
        }
        dateInput.onchange = () => {
            if (this.isRecurring) {
                this.startRecur = dateInput.value;
            } else {
                // For one-time tasks
            }
        };
        // Always open date picker on focus/pointerdown if supported
        const openDatePicker = (e: Event) => {
            if (dateInput.showPicker) {
                e.preventDefault();
                dateInput.showPicker();
            }
        };
        dateInput.addEventListener('focus', openDatePicker);
        dateInput.addEventListener('pointerdown', openDatePicker);

        // Due time
        const timeInput = contentEl.createEl('input', { type: 'time', attr: { placeholder: 'Time (optional)', style: 'width: 100%; margin-bottom: 8px;' } });
        if (this.existingTask?.dueTime) timeInput.value = this.existingTask.dueTime;

        // Priority
        const prioritySelect = contentEl.createEl('select', { attr: { style: 'width: 100%; margin-bottom: 8px;' } });
        ["None", "Low", "Medium", "High"].forEach((p: string) => {
            const opt = document.createElement('option');
            opt.value = p.toLowerCase();
            opt.text = p;
            prioritySelect.appendChild(opt);
        });
        if (this.existingTask?.priority) prioritySelect.value = this.existingTask.priority;

        // Folder
        const folderSelect = contentEl.createEl('select', { attr: { style: 'width: 100%; margin-bottom: 16px;' } });
        this.calendarFolders.forEach((folder: string) => {
            const opt = document.createElement('option');
            opt.value = folder;
            opt.text = folder;
            folderSelect.appendChild(opt);
        });
        if (this.existingTask?.folder) folderSelect.value = this.existingTask.folder;

        // Recurrence Toggle
        new Setting(contentEl)
            .setName("Enable Recurrence")
            .addToggle(toggle => {
                toggle.setValue(this.isRecurring)
                    .onChange(value => {
                        this.isRecurring = value;
                        // Only show/hide recurrence fields and update label, do not re-render modal
                        recurrenceFieldsWrapper.style.display = value ? '' : 'none';
                        dateLabel.textContent = value ? 'Start Date' : 'Due Date';
                    });
            });

        // Recurrence Options Wrapper (hidden if not recurring)
        const recurrenceFieldsWrapper = contentEl.createDiv({ attr: { style: this.isRecurring ? '' : 'display: none;' } });
        // Days of week
        const daysOuterSetting = new Setting(recurrenceFieldsWrapper)
            .setName("Repeat on Days")
            .setDesc("Select days for weekly recurrence.");
        const daysGrid = daysOuterSetting.controlEl.createDiv({
            cls: 'obby-days-checkboxes-grid',
            attr: { style: 'display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px 18px; margin-top: 10px; margin-bottom: 10px; align-items: center;' }
        });
        this.daysOfWeekMap.forEach((dayName, index) => {
            const cell = daysGrid.createDiv({ attr: { style: 'display: flex; align-items: center;' } });
            const checkboxId = `task-day-checkbox-${index}`;
            const checkbox = cell.createEl('input', {
                type: 'checkbox',
                attr: { id: checkboxId, style: 'margin-right: 6px;' }
            });
            checkbox.checked = this.daysOfWeek.includes(index);
            checkbox.onchange = (event) => {
                const checked = (event.target as HTMLInputElement).checked;
                if (checked) {
                    if (!this.daysOfWeek.includes(index)) this.daysOfWeek.push(index);
                } else {
                    this.daysOfWeek = this.daysOfWeek.filter(d => d !== index);
                }
                this.daysOfWeek.sort((a,b) => a-b);
            };
            cell.createEl('label', { text: dayName, attr: { for: checkboxId, style: 'font-size: 1em; font-weight: 400;' } });
        });
        // End date
        const endDateLabel = recurrenceFieldsWrapper.createEl('span', { text: 'End Recurrence (Optional)' });
        const endDateInput = recurrenceFieldsWrapper.createEl('input', { type: 'date', attr: { style: 'width: 100%; margin-bottom: 8px;' } });
        endDateInput.value = this.endRecur || '';
        endDateInput.onchange = () => { this.endRecur = endDateInput.value || ''; };
        // Always open date picker on focus/pointerdown if supported
        const openEndDatePicker = (e: Event) => {
            if (endDateInput.showPicker) {
                e.preventDefault();
                endDateInput.showPicker();
            }
        };
        endDateInput.addEventListener('focus', openEndDatePicker);
        endDateInput.addEventListener('pointerdown', openEndDatePicker);

        const addBtn = contentEl.createEl('button', {
            text: this.filePath ? 'Update' : 'Add Task',
            attr: {
                style: 'width: 100%; padding: 10px 0; border-radius: 4px; border: none; background: var(--interactive-accent); color: var(--text-on-accent); font-weight: bold; cursor: pointer; font-size: 1em;'
            }
         });

        if (this.filePath) {
            const deleteBtn = contentEl.createEl('button', {
                text: 'Delete Task',
                attr: {
                    style: 'width: 100%; padding: 10px 0; border-radius: 4px; border: 1px solid var(--text-error); background: transparent; color: var(--text-error); font-weight: bold; cursor: pointer; font-size: 1em; margin-top: 10px;'
                }
            });
            deleteBtn.onclick = async () => {
                if (confirm('Are you sure you want to delete this task? This cannot be undone.')) {
                    try {
                        const file = this.app.vault.getAbstractFileByPath(this.filePath!);
                        if (file) {
                            await this.app.vault.delete(file);
                            new Notice('Task deleted.');
                            this.onSubmit();
                            this.close();
                        }
                    } catch (e: any) {
                        new Notice(`Error deleting task: ${e.message}`);
                    }
                }
            };
        }

        addBtn.onclick = async () => {
            if (this.isRecurring && (!dateInput.value || this.daysOfWeek.length === 0)) {
                new Notice("Recurring tasks require a start date and at least one day of the week.");
                return;
            }

            const title = titleInput.value.trim();
            if (!title) {
                new Notice("Title is required.");
                return;
            }

            const description = descInput.value.trim();
            const dateVal = dateInput.value;
            const dueTime = timeInput.value;
            const priority = prioritySelect.value;
            const selectedFolder = folderSelect.value;
            const todosFolderPath = `${selectedFolder}/todos`;

            try {
                if (!this.app.vault.getAbstractFileByPath(todosFolderPath)) {
                    await this.app.vault.createFolder(todosFolderPath);
                }
            } catch (e) {
                new Notice(`Error creating folder: ${e.message}`);
                return;
            }

            let fileContent = '---\n';
            fileContent += `title: ${title}\n`;
            if (description) fileContent += `description: "${description.replace(/"/g, '\\"')}"\n`;
            if (dueTime) fileContent += `dueTime: ${dueTime}\n`;
            if (priority && priority.toLowerCase() !== 'none') fileContent += `priority: ${priority}\n`;
            
            if (this.isRecurring) {
                fileContent += `isRecurring: true\n`;
                fileContent += `daysOfWeek: [${this.daysOfWeek.join(',')}]\n`;
                if (dateVal) {
                    fileContent += `startRecur: ${dateVal}\n`;
                }
                if (this.endRecur) fileContent += `endRecur: ${this.endRecur}\n`;
                // No 'completed' flag for the template
            } else {
                fileContent += `completed: false\n`; // Only for non-recurring
                if (dateVal) {
                    fileContent += `due: ${dateVal}\n`;
                }
            }
            fileContent += '---\n\n';
            if (description) fileContent += description;

            const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, "");
            const filename = this.filePath || `${todosFolderPath}/${sanitizedTitle}.md`;

            try {
                if (this.filePath) {
                    await this.app.vault.modify(this.app.vault.getAbstractFileByPath(this.filePath) as TFile, fileContent);
                } else {
                    await this.app.vault.create(filename, fileContent);
                }
                new Notice(`Task '${title}' saved.`);
                this.onSubmit();
                this.close();
            } catch (e: any) {
                new Notice(`Error saving task: ${e.message}`);
            }
        };
    }
} 