# A real LangGraph multi-agent service: a planner agent and an executor agent that exchange messages to perform a task.
# Genuine multi-service state: every inter-agent message is persisted to POSTGRES (run history) and streamed to REDIS
# (a per-run message stream the web frontend tails). The LLM is called over an OpenAI-compatible endpoint (LiteLLM).
#
# Front door (how Everdict drives it): POST /runs {task, thread_id} runs planner -> executor synchronously and returns
# {run_id, output, plan, messages, trace}. GET /runs/{id} reads the persisted run back from Postgres (proves the store).
import json
import os
import time
import uuid
from typing import Annotated, TypedDict

import psycopg
import redis
from fastapi import FastAPI
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from pydantic import BaseModel

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://everdict:everdict@postgres:5432/everdict")
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379")
MODEL = os.environ.get("MODEL", "gpt-5.4-mini")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "http://172.17.0.1:4000/v1")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "sk-noauth")

llm = ChatOpenAI(model=MODEL, base_url=OPENAI_BASE_URL, api_key=OPENAI_API_KEY, temperature=0)
rds = redis.Redis.from_url(REDIS_URL, decode_responses=True)


def db():
    return psycopg.connect(DATABASE_URL, autocommit=True)


def init_db():
    for _ in range(30):
        try:
            with db() as c:
                c.execute(
                    "CREATE TABLE IF NOT EXISTS runs ("
                    "run_id TEXT PRIMARY KEY, task TEXT, plan TEXT, output TEXT, messages JSONB, created_at DOUBLE PRECISION)"
                )
            return
        except Exception as e:  # postgres may still be booting
            print("db not ready, retrying:", e, flush=True)
            time.sleep(2)
    raise RuntimeError("postgres never became ready")


class RunState(TypedDict):
    task: str
    run_id: str
    plan: str
    output: str
    messages: Annotated[list, add_messages]


def _emit(run_id: str, frm: str, to: str, content: str, trace: list):
    # Inter-agent message: streamed to Redis (the frontend tails it) + accumulated for persistence/trace.
    msg = {"from": frm, "to": to, "content": content, "t": time.time()}
    trace.append(msg)
    try:
        rds.xadd(f"run:{run_id}", {"from": frm, "to": to, "content": content[:4000]}, maxlen=1000)
    except Exception as e:
        print("redis xadd failed:", e, flush=True)


def make_graph(trace: list):
    def planner(state: RunState):
        # Agent 1 — decompose the task into concrete steps.
        rsp = llm.invoke(
            [
                ("system", "You are a planner agent. Break the user's task into 2-4 short, concrete steps. Steps only."),
                ("user", state["task"]),
            ]
        )
        plan = rsp.content
        _emit(state["run_id"], "planner", "executor", f"Here is the plan:\n{plan}", trace)
        return {"plan": plan, "messages": [("assistant", plan)]}

    def executor(state: RunState):
        # Agent 2 — execute the planner's plan and produce the final answer.
        rsp = llm.invoke(
            [
                ("system", "You are an executor agent. Follow the plan from the planner and produce the FINAL answer to the task. Be correct and concise."),
                ("user", f"Task: {state['task']}\n\nPlan from planner:\n{state['plan']}\n\nNow produce the final answer."),
            ]
        )
        out = rsp.content
        _emit(state["run_id"], "executor", "user", out, trace)
        return {"output": out, "messages": [("assistant", out)]}

    g = StateGraph(RunState)
    g.add_node("planner", planner)
    g.add_node("executor", executor)
    g.add_edge(START, "planner")
    g.add_edge("planner", "executor")
    g.add_edge("executor", END)
    return g.compile()


app = FastAPI()


@app.on_event("startup")
def _startup():
    init_db()


class RunReq(BaseModel):
    task: str
    thread_id: str | None = None


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/runs")
def run(req: RunReq):
    run_id = req.thread_id or uuid.uuid4().hex
    trace: list = []
    graph = make_graph(trace)
    final = graph.invoke({"task": req.task, "run_id": run_id, "plan": "", "output": "", "messages": []})
    plan, output = final.get("plan", ""), final.get("output", "")
    with db() as c:  # persist the run (proves Postgres is used, not just wired)
        c.execute(
            "INSERT INTO runs (run_id, task, plan, output, messages, created_at) VALUES (%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (run_id) DO UPDATE SET plan=EXCLUDED.plan, output=EXCLUDED.output, messages=EXCLUDED.messages",
            (run_id, req.task, plan, output, json.dumps(trace), time.time()),
        )
    # Everdict front door: the output is the observation the judge scores; trace = the inter-agent messages.
    return {
        "run_id": run_id,
        "output": output,
        "plan": plan,
        "messages": trace,
        "trace": [{"t": i, "kind": "agent_message", "message": f"{m['from']}->{m['to']}: {m['content'][:500]}"} for i, m in enumerate(trace)],
    }


@app.get("/runs/{run_id}")
def get_run(run_id: str):
    with db() as c:
        row = c.execute("SELECT run_id, task, plan, output, messages FROM runs WHERE run_id=%s", (run_id,)).fetchone()
    if not row:
        return {"error": "not found"}
    return {"run_id": row[0], "task": row[1], "plan": row[2], "output": row[3], "messages": row[4]}
