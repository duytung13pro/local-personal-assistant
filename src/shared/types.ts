// Types shared by the Electron main process, the preload bridge and the React renderer.

export type Priority = "low" | "normal" | "high";

export interface Task {
  id: string;
  title: string;
  notes: string;
  due: string; // YYYY-MM-DD or ""
  priority: Priority;
  done: boolean;
  doneAt: string;
  created: string;
  updated: string;
}

export interface CalEvent {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD
  start: string; // HH:MM or "" (all day)
  end: string;
  notes: string;
  created: string;
  updated: string;
}

export interface UndoEntry {
  id: number;
  label: string;
}

export interface Project {
  id: string;
  title: string;
  brief: string;
  notes: string;
  created: string;
  updated: string;
}

import type { WorkerId } from "./workers";
export type { WorkerId } from "./workers";
export type AgentId = WorkerId;

export type StepStatus = "todo" | "queued" | "running" | "done" | "failed";

export interface Step {
  id: string;
  projectId: string;
  idx: number;
  title: string;
  agent: WorkerId;
  why: string;
  prompt: string;
  deps: string[]; // ids of steps that must finish first
  status: StepStatus;
  output: string;
  updated: string;
}

export interface Job {
  id: string;
  projectId: string;
  stepId: string;
  agent: WorkerId;
  title: string;
  status: "running" | "done" | "failed";
  output: string;
  error: string;
  started: string;
  finished: string;
}

export interface AgentStatus {
  id: WorkerId;
  name: string;
  available: boolean;
  detail: string; // version, model or reason
  hint: string; // what to do when unavailable
  cloud: boolean;
  model: string; // "" for cloud agents
  enabled: boolean;
}

export interface ConnectionsReport {
  agents: AgentStatus[];
  ollamaModels: string[];
  loadedModels: string[]; // models Ollama currently has in memory
  dataDir: string;
  oldDbFound: boolean;
  maxParallel: number;
}

export interface PlanResult { steps: Step[]; plannedBy: WorkerId | "rules"; note: string }

export interface ImportResult {
  tasks: number;
  events: number;
  projects: number;
  skipped: number;
}

/** Everything the renderer may call. Implemented in preload.ts via ipcRenderer.invoke. */
export interface Api {
  listTasks(): Promise<Task[]>;
  addTask(t: { title: string; due?: string; priority?: Priority; notes?: string }): Promise<Task>;
  updateTask(id: string, t: Partial<Pick<Task, "title" | "due" | "priority" | "notes">>): Promise<Task>;
  setTaskDone(id: string, done: boolean): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  listEvents(from: string, to: string): Promise<CalEvent[]>;
  addEvent(e: Omit<CalEvent, "id" | "created" | "updated">): Promise<CalEvent>;
  updateEvent(id: string, e: Partial<Omit<CalEvent, "id" | "created" | "updated">>): Promise<CalEvent>;
  deleteEvent(id: string): Promise<void>;

  latestUndo(): Promise<UndoEntry | null>;
  undo(): Promise<string | null>;

  listProjects(): Promise<Project[]>;
  createProject(title: string): Promise<Project>;
  updateProject(id: string, p: Partial<Pick<Project, "title" | "brief" | "notes">>): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  projectFolder(id: string): Promise<string>;
  listFiles(id: string): Promise<{ path: string; size: number }[]>;
  readFile(id: string, path: string): Promise<string>;

  listSteps(projectId: string): Promise<Step[]>;
  previewPlan(projectId: string): Promise<string>; // exact text ChatGPT receives when planning
  planSteps(projectId: string): Promise<PlanResult>;
  previewReview(projectId: string): Promise<string>;
  reviewProject(projectId: string): Promise<PlanResult>; // ChatGPT reviews results and may add follow-ups
  updateStep(id: string, s: Partial<Pick<Step, "title" | "agent" | "prompt">>): Promise<Step>;
  deleteStep(id: string): Promise<void>;
  previewStep(id: string): Promise<string>; // exact text that would be sent
  runStep(id: string): Promise<void>; // queue one step (runs when its dependencies are done)
  runAll(projectId: string): Promise<number>; // queue every unfinished step; returns how many
  stopQueue(projectId: string): Promise<void>; // un-queue steps that have not started

  listJobs(limit?: number): Promise<Job[]>;
  connections(): Promise<ConnectionsReport>;
  warmUp(): Promise<string>; // load local models into memory in the background
  setWorkerModel(worker: WorkerId, model: string): Promise<void>;
  setWorkerEnabled(worker: WorkerId, enabled: boolean): Promise<void>;
  importOld(): Promise<ImportResult>;
  openPath(path: string): Promise<void>;

  onChanged(cb: (what: string) => void): () => void;
}
