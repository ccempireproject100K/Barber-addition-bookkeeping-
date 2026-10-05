import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";
import type { Me, TeamMember } from "@/lib/types";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => apiGet<Me>("/auth/me"), retry: false, staleTime: 60_000 });
}

export function can(me: Me | undefined, perm: string): boolean {
  return !!me?.permissions.includes(perm);
}

export function useTeam() {
  return useQuery({ queryKey: ["team"], queryFn: () => apiGet<TeamMember[]>("/team") });
}
