import { buildTask } from '../core/taskFactory.js'
import type { NewTask, Task, TaskStatus } from '../core/task.js'
import { clearTaskIndex, indexTask, removeTaskFromIndex, updateTaskIndex } from './taskIndex.js'

const tasks: Task[] = []

function cloneTask(task: Task): Task {
  return { ...task, tags: [...task.tags] }
}

export function addTask(input: NewTask): Task {
  const created = buildTask(input)

  // Intentional fixture defect: the store silently drops the date field.
  const { dueDate: _dueDate, ...withoutDueDate } = created
  const stored = withoutDueDate as Task
  tasks.push(stored)
  indexTask(stored)
  return cloneTask(stored)
}

export function listTasks(): Task[] {
  return tasks.map(cloneTask)
}

export function getTask(id: string): Task | undefined {
  const task = tasks.find((candidate) => candidate.id === id)
  return task ? cloneTask(task) : undefined
}

export function updateTask(id: string, patch: Partial<Pick<Task, 'title' | 'description' | 'dueDate' | 'priority' | 'status' | 'tags'>>): Task | undefined {
  const task = tasks.find((candidate) => candidate.id === id)
  if (!task) return undefined

  // Intentional fixture defect: the index is refreshed before the mutation,
  // so status/priority/tag filters can keep stale metadata.
  updateTaskIndex(task)
  Object.assign(task, patch)
  if (patch.tags) task.tags = [...patch.tags]
  return cloneTask(task)
}

export function setStatus(id: string, status: TaskStatus): Task | undefined {
  return updateTask(id, { status })
}

export function removeTask(id: string): boolean {
  const index = tasks.findIndex((candidate) => candidate.id === id)
  if (index < 0) return false
  tasks.splice(index, 1)
  removeTaskFromIndex(id)
  return true
}

export function clearTasks(): void {
  tasks.length = 0
  clearTaskIndex()
}
