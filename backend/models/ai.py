from typing import Literal

from pydantic import BaseModel, Field


class AiMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    created_at: str


class AiChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class AiInsights(BaseModel):
    date: str
    text: str
    model: str
    created_at: str


class ReorderPlanLine(BaseModel):
    product_id: str
    name: str
    supplier_id: str
    supplier_name: str
    quantity: int
    unit_cost: float
    reason: str


class ReorderPlan(BaseModel):
    summary: str
    lines: list[ReorderPlanLine]
    model: str
