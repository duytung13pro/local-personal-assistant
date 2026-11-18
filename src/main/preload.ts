// Exposes a small, typed API to the renderer. The renderer has no Node access.
import { contextBridge, ipcRenderer } from "electron";
import type { Api } from "../shared/types";

const call = async (name: string, ...args: unknown[]) => {
  const r = await ipcRenderer.invoke(`pa:${name}`, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const names = ["listTasks", "addTask", "updateTask", "setTaskDone", "deleteTask", "listEvents", "addEvent", "updateEvent",
  "deleteEvent", "latestUndo", "undo", "listProjects", "createProject", "updateProject", "deleteProject", "projectFolder",
  "listFiles", "readFile", "listSteps", "previewPlan", "planSteps", "previewReview", "reviewProject", "updateStep", "deleteStep",
  "previewStep", "runStep", "runAll", "stopQueue", "listJobs", "listChat", "sendChat", "declineStep", "stopChat", "rerunChat", "chatUsage", "connections", "warmUp", "setWorkerModel", "setWorkerEnabled", "importOld",
  "openPath"] as const;

const api = Object.fromEntries(names.map((n) => [n, (...a: unknown[]) => call(n, ...a)])) as unknown as Api;
api.onChanged = (cb) => {
  const listener = (_e: unknown, what: string) => cb(what);
  ipcRenderer.on("pa:changed", listener);
  return () => ipcRenderer.removeListener("pa:changed", listener);
};

api.onChatDelta = (cb) => {
  const listener = (_e: unknown, id: string, text: string) => cb(id, text);
  ipcRenderer.on("pa:chatDelta", listener);
  return () => ipcRenderer.removeListener("pa:chatDelta", listener);
};

contextBridge.exposeInMainWorld("pa", api);
