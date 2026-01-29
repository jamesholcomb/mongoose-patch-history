import {
  ClientSession,
  Document,
  Model,
  Mongoose,
  SchemaDefinitionProperty,
  Types
} from 'mongoose'

// ============================================================================
// Type Definitions
// ============================================================================

/** Schema include configuration for additional fields in patch documents */
export interface SchemaInclude {
  type: SchemaDefinitionProperty
  required?: boolean
  from?: string
}

/** Plugin options passed by the user */
export interface PatchHistoryOptions {
  mongoose: Mongoose
  name: string
  includes?: Record<string, SchemaInclude>
  excludes?: string[]
  removePatches?: boolean
  transforms?: [(name: string) => string, (name: string) => string]
  trackOriginalValue?: boolean
}

/** Internal resolved options with computed properties */
export interface ResolvedOptions {
  mongoose: Mongoose
  name: string
  _idType: SchemaDefinitionProperty
  excludes: string[][]
  includes: Record<string, SchemaInclude>
  removePatches: boolean
  transforms: [(name: string) => string, (name: string) => string]
  trackOriginalValue: boolean
}

/** JSON Patch operation type - includes _get for internal fast-json-patch operations */
export interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test' | '_get'
  path: string
  value?: unknown
  from?: string
  originalValue?: unknown
}

/** Patch data input for creating a patch document */
export interface PatchDataInput {
  date: Date
  ops: PatchOperation[]
  ref: Types.ObjectId | string | number
  [key: string]: unknown
}

/** Patch document structure (extends Document for queried documents) */
export interface PatchData extends Document {
  date: Date
  ops: PatchOperation[]
  ref: Types.ObjectId | string | number
  [key: string]: unknown
}

/** Document with patch history methods and properties */
export interface PatchHistoryDocument extends Document {
  _original?: Record<string, unknown>
  patches: Model<PatchData>
  data(): Record<string, unknown>
  rollback(
    patchId: Types.ObjectId | string,
    data?: Record<string, unknown>,
    save?: boolean
  ): Promise<PatchHistoryDocument>
}

/** Query context for update operations */
export interface UpdateQueryContext {
  model: Model<Document>
  _conditions: Record<string, unknown>
  _update?: Record<string, unknown>
  _original?: Record<string, unknown>
  _originalId?: Types.ObjectId
  _originalIds?: Types.ObjectId[]
  _originals?: Record<string, unknown>[]
  options: Record<string, unknown>
  getOptions(): { session?: ClientSession }
}
