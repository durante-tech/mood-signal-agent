/**
 * Synthetic HR data for the proof of concept. Every name and fact below is
 * invented. The store lives in memory and is lost when the process exits.
 */
import type { Employee, Notification } from "../types.ts";

export interface HrStore {
  employees: Map<string, Employee>;
  /** Notifications sent through `notify_manager`, oldest first. */
  outbox: Notification[];
}

const SEED: Employee[] = [
  {
    id: "e-001",
    name: "Marta Oliveira",
    role: "VP of Engineering",
    team: "Leadership",
    managerId: null,
    notes: ["Tenure: 6 years.", "Time zone: UTC-3.", "Runs a weekly staff meeting on Mondays."],
  },
  {
    id: "e-002",
    name: "Daniel Okafor",
    role: "Engineering Manager",
    team: "Platform",
    managerId: "e-001",
    notes: ["Tenure: 4 years.", "Time zone: UTC+1.", "Manages three engineers; holds 1:1s every other Thursday."],
  },
  {
    id: "e-003",
    name: "Priya Raman",
    role: "Senior Software Engineer",
    team: "Platform",
    managerId: "e-002",
    notes: [
      "Tenure: 3 years.",
      "Time zone: UTC+1.",
      "Current load: on call this week and leading the database migration due Friday.",
      "Took no leave in the last five months.",
    ],
  },
  {
    id: "e-004",
    name: "Tomas Lindqvist",
    role: "Software Engineer",
    team: "Platform",
    managerId: "e-002",
    notes: ["Tenure: 8 months.", "Time zone: UTC+1.", "Current load: two support tickets, no deadlines this sprint."],
  },
  {
    id: "e-005",
    name: "Aiko Tanaka",
    role: "Site Reliability Engineer",
    team: "Platform",
    managerId: "e-002",
    notes: ["Tenure: 2 years.", "Time zone: UTC+9.", "Current load: paged three nights in a row last week."],
  },
  {
    id: "e-006",
    name: "Rafael Costa",
    role: "Engineering Manager",
    team: "Product",
    managerId: "e-001",
    notes: ["Tenure: 5 years.", "Time zone: UTC-3.", "Manages three people; the team ships a release every two weeks."],
  },
  {
    id: "e-007",
    name: "Hannah Weber",
    role: "Frontend Engineer",
    team: "Product",
    managerId: "e-006",
    notes: [
      "Tenure: 1 year.",
      "Time zone: UTC+2.",
      "Current load: sole owner of the checkout redesign, launch next Tuesday.",
    ],
  },
  {
    id: "e-008",
    name: "Samuel Mensah",
    role: "Backend Engineer",
    team: "Product",
    managerId: "e-006",
    notes: ["Tenure: 2 years.", "Time zone: UTC+0.", "Current load: back this week from two weeks of parental leave."],
  },
  {
    id: "e-009",
    name: "Lucia Ferreira",
    role: "Product Designer",
    team: "Product",
    managerId: "e-006",
    notes: ["Tenure: 3 years.", "Time zone: UTC-3.", "Current load: supporting two squads at once since a teammate left."],
  },
];

/** A fresh store with the seeded employees and an empty outbox. */
export function seedStore(): HrStore {
  const employees = new Map<string, Employee>();
  for (const e of SEED) employees.set(e.id, { ...e, notes: [...e.notes] });
  return { employees, outbox: [] };
}
