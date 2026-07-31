'use server'

import { revalidatePath } from 'next/cache'

import { agentTaskListSchema, agentTaskSchema, type AgentTask } from '@/entities/agent-task'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

// 태스크 원장 서버 액션 — 컨트롤플레인 /tasks 의 순수 HTTP 클라이언트(authZ 는 컨트롤플레인이 담당:
// 읽기 agents:read · 쓰기 agents:write · 삭제 creator/admin). 상태 전이 팩트(task.claimed 등)는 서버가 방출.

export interface TaskActionResult {
  ok: boolean
  task?: AgentTask
  error?: string
}

export async function listTasksAction(status?: string): Promise<AgentTask[]> {
  const ctx = await authContext()
  return agentTaskListSchema.parse(await controlPlane.listTasks(ctx, status))
}

export async function createTaskAction(input: {
  subject: string
  description?: string
  owner?: string
  blockedBy?: string[]
}): Promise<TaskActionResult> {
  const ctx = await authContext()
  try {
    const task = agentTaskSchema.parse(await controlPlane.createTask(ctx, input))
    revalidatePath('/[workspace]/agents/tasks', 'page')
    return { ok: true, task }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateTaskAction(
  id: string,
  patch: {
    subject?: string
    description?: string
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled'
    owner?: string
    blockedBy?: string[]
  }
): Promise<TaskActionResult> {
  const ctx = await authContext()
  try {
    const task = agentTaskSchema.parse(await controlPlane.updateTask(ctx, id, patch))
    revalidatePath('/[workspace]/agents/tasks', 'page')
    return { ok: true, task }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function deleteTaskAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await authContext()
  try {
    await controlPlane.deleteTask(ctx, id)
    revalidatePath('/[workspace]/agents/tasks', 'page')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
