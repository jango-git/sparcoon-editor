import type { FXInheritLayout } from "sparcoon";

import type { FXValueType } from "../core/socket/FXValueType";

/** A core field of the dying particle a newborn can inherit. */
export type FXInheritBuiltin = "id" | "lifetime";

/** Where an inherited value comes from: a user attribute of the dying particle, by name, or a
 *  core field. */
export type FXInheritSource =
  | { readonly kind: "attribute"; readonly name: string }
  | { readonly kind: "builtin"; readonly field: FXInheritBuiltin };

/** One value a spawn graph inherits: its source, its type, and what a birth no death spawned
 *  reads instead (`type.components` floats). See `FXInherit.ts`. */
export interface FXInheritRequest {
  readonly source: FXInheritSource;
  readonly type: FXValueType;
  readonly defaults: readonly number[];
}

/** One placed value of an inherit layout: its request, the kernel input reading it, and where
 *  its floats start. */
export interface FXInheritEntry {
  readonly request: FXInheritRequest;
  readonly inputName: string;
  readonly offset: number;
}

/** A graph's inherit layout: its placed values, and the runtime layout they make. */
export interface FXInheritPlan {
  readonly entries: readonly FXInheritEntry[];
  readonly layout: FXInheritLayout;
}
