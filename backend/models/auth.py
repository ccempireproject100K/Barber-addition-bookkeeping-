from typing import Literal
from lib.international import InternationalSettings

from pydantic import BaseModel, EmailStr, Field

Role = Literal["admin", "staff", "accountant", "bookkeeper"]


class SignupIn(InternationalSettings):
    company_name: str = Field(min_length=1, max_length=120)
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class Me(InternationalSettings):
    user_id: str
    name: str
    email: str
    role: Role
    tenant_id: str
    tenant_name: str
    permissions: list[str]
    inventory_enabled: bool
    ai_enabled: bool = False
    access: Literal["demo", "paid", "none"] = "none"
    entitlements: dict[str, bool] = {}


class TeamMember(BaseModel):
    id: str
    name: str
    email: str
    role: Role
    commission_rate: float = 0
    created_at: str


class TeamMemberCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Role = "staff"
    commission_rate: float = Field(default=0, ge=0, le=100)


class TeamMemberUpdate(BaseModel):
    commission_rate: float = Field(ge=0, le=100)
    role: Role


class GoogleSessionIn(BaseModel):
    session_id: str = Field(min_length=1, max_length=512)


class PasswordResetRequestIn(BaseModel):
    email: EmailStr


class PasswordResetConfirmIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=8, max_length=128)


class OkOut(BaseModel):
    ok: bool = True
    message: str = ""
