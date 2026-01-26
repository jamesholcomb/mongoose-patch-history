import assert from 'assert'
import jsonpatch from 'fast-json-patch'
import {
  camelCase,
  dropRightWhile,
  each,
  get,
  merge,
  omit,
  snakeCase,
  tail
} from 'lodash'
import {
  ClientSession,
  Document,
  Model,
  Mongoose,
  Query,
  Schema,
  SchemaDefinitionProperty,
  Types
} from 'mongoose'
import { inherits } from 'util'

// ============================================================================
// Type Definitions
// ============================================================================

/** Schema include configuration for additional fields in patch documents */
interface SchemaInclude {
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
interface ResolvedOptions {
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
interface PatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test' | '_get'
  path: string
  value?: unknown
  from?: string
  originalValue?: unknown
}

/** Patch data input for creating a patch document */
interface PatchDataInput {
  date: Date
  ops: PatchOperation[]
  ref: Types.ObjectId | string | number
  [key: string]: unknown
}

/** Patch document structure (extends Document for queried documents) */
interface PatchData extends Document {
  date: Date
  ops: PatchOperation[]
  ref: Types.ObjectId | string | number
  [key: string]: unknown
}

/** Document with patch history methods and properties */
interface PatchHistoryDocument extends Document {
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
interface UpdateQueryContext {
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

// ============================================================================
// Error Classes
// ============================================================================

export class RollbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RollbackError'
    Error.captureStackTrace(this, this.constructor)
  }
}

inherits(RollbackError, Error)

// ============================================================================
// Helper Functions
// ============================================================================

const createPatchModel = (options: ResolvedOptions): Model<PatchData> => {
  const def: Record<string, SchemaDefinitionProperty> = {
    date: { type: Date, required: true, default: Date.now },
    ops: { type: [], required: true },
    ref: { type: options._idType, required: true, index: true }
  }

  each(options.includes, (type: SchemaInclude, name: string) => {
    def[name] = omit(type, 'from') as SchemaDefinitionProperty
  })

  const PatchSchema = new Schema<PatchData>(def)

  return options.mongoose.model<PatchData>(
    options.transforms[0](`${options.name}`),
    PatchSchema,
    options.transforms[1](`${options.name}`)
  )
}

export const defaultOptions = {
  includes: {},
  excludes: [] as string[],
  removePatches: true,
  transforms: [camelCase, snakeCase] as [
    (name: string) => string,
    (name: string) => string
  ],
  trackOriginalValue: false
}

const ARRAY_INDEX_WILDCARD = '*'

/**
 * Splits a json-patch-path of form `/path/to/object` to an array `['path', 'to', 'object']`.
 * Note: `/` is returned as `[]`
 *
 * @param path Path to split
 */
const getArrayFromPath = (path: string): string[] =>
  path.replace(/^\//, '').split('/')

/**
 * Checks the provided `json-patch-operation` on `excludePath`.
 * This check joins the `path` and `value` property of the `operation`
 * and removes any hit.
 *
 * @param patch operation to check with `excludePath`
 * @param excludePath Path to property to remove from value of `operation`
 *
 * @return `false` if `patch.value` is `{}` or `undefined` after remove, `true` in any other case
 */
const deepRemovePath = (
  patch: PatchOperation,
  excludePath: string[]
): boolean => {
  const operationPath: string[] = sanitizeEmptyPath(
    getArrayFromPath(patch.path)
  )

  if (isPathContained(operationPath, excludePath)) {
    let value = patch.value as Record<string, unknown> | unknown[] | undefined

    // because the paths overlap start at patchPath.length
    // e.g.: patch: { path:'/object', value:{ property: 'test' } }
    // pathToExclude: '/object/property'
    // need to start at array idx 1, because value starts at idx 0
    for (let i = operationPath.length; i < excludePath.length - 1; i++) {
      if (excludePath[i] === ARRAY_INDEX_WILDCARD && Array.isArray(value)) {
        // start over with each array element and make a fresh check
        // Note: it can happen that array elements are rendered to: {}
        //         we need to keep them to keep the order of array elements consistent
        value.forEach((elem: unknown) => {
          deepRemovePath(
            { op: 'add', path: '/', value: elem },
            excludePath.slice(i + 1)
          )
        })

        // If the patch value has turned to {} return false so this patch can be filtered out
        const patchValue = patch.value as Record<string, unknown>
        if (Object.keys(patchValue).length === 0) {
          return false
        }
        return true
      }
      value = (value as Record<string, unknown>)?.[excludePath[i]] as
        | Record<string, unknown>
        | undefined

      if (typeof value === 'undefined') {
        return true
      }
    }
    const lastKey = excludePath[excludePath.length - 1]
    if (typeof (value as Record<string, unknown>)?.[lastKey] === 'undefined') {
      return true
    } else {
      delete (value as Record<string, unknown>)[lastKey]
      // If the patch value has turned to {} return false so this patch can be filtered out
      const patchValue = patch.value as Record<string, unknown>
      if (Object.keys(patchValue).length === 0) {
        return false
      }
    }
  }

  return true
}

/**
 * Sanitizes a path `['']` to be used with `isPathContained()`
 * @param path
 */
const sanitizeEmptyPath = (path: string[]): string[] =>
  path.length === 1 && path[0] === '' ? [] : path

// Checks if 'fractionPath' is contained in fullPath
// Exp. 1: fractionPath '/path/to',              fullPath '/path/to/object'       => true
// Exp. 2: fractionPath '/arrayPath/*/property', fullPath '/arrayPath/1/property' => true
const isPathContained = (fractionPath: string[], fullPath: string[]): boolean =>
  fractionPath.every(
    (entry: string, idx: number) =>
      entryIsIdentical(entry, fullPath[idx]) ||
      matchesArrayWildcard(entry, fullPath[idx])
  )

const entryIsIdentical = (entry1: string, entry2: string): boolean =>
  entry1 === entry2

const matchesArrayWildcard = (entry1: string, entry2: string): boolean =>
  isArrayIndexWildcard(entry1) && isIntegerGreaterEqual0(entry2)

const isArrayIndexWildcard = (entry: string): boolean =>
  entry === ARRAY_INDEX_WILDCARD

const isIntegerGreaterEqual0 = (entry: string): boolean =>
  Number.isInteger(Number(entry)) && Number(entry) >= 0

// used to convert bson to json - especially ObjectID references need
// to be converted to hex strings so that the jsonpatch `compare` method
// works correctly
const toJSON = <T>(obj: T): T => JSON.parse(JSON.stringify(obj))

// helper function to merge query conditions after an update has happened
// useful if a property which was initially defined in _conditions got overwritten
// with the update
const mergeQueryConditionsWithUpdate = (
  _conditions: Record<string, unknown>,
  _update?: Record<string, unknown>
): Record<string, unknown> => {
  const update = _update
    ? (_update.$set as Record<string, unknown>) || _update
    : _update
  const conditions: Record<string, unknown> = Object.assign(
    {},
    _conditions,
    update
  )

  // excluding updates other than $set
  Object.keys(conditions).forEach((key: string) => {
    if (key.includes('$')) {
      delete conditions[key]
    }
  })
  return conditions
}

// ============================================================================
// Main Plugin
// ============================================================================

export default function (schema: Schema, opts: PatchHistoryOptions): void {
  // Build resolved options
  const options: ResolvedOptions = {
    mongoose: opts.mongoose,
    name: opts.name,
    _idType: schema.paths['_id'].options.type,
    excludes: (opts.excludes || []).map(getArrayFromPath),
    includes: opts.includes || {},
    removePatches: opts.removePatches !== undefined ? opts.removePatches : true,
    transforms: opts.transforms || [camelCase, snakeCase],
    trackOriginalValue: opts.trackOriginalValue || false
  }

  // validate parameters
  assert(options.mongoose, '`mongoose` option must be defined')
  assert(options.name, '`name` option must be defined')
  assert(!schema.methods.data, 'conflicting instance method: `data`')
  assert(options._idType, 'schema is missing an `_id` property')

  // used to compare instance data snapshots. depopulates instance,
  // removes version key and object id
  schema.methods.data = function (
    this: PatchHistoryDocument
  ): Record<string, unknown> {
    return this.toObject({
      depopulate: true,
      versionKey: false,
      transform: (_doc: Document, ret: Record<string, unknown>) => {
        delete ret._id

        // if timestamps option is set on schema, remove timestamp fields
        const config = schema.get('timestamps')

        if (config === true) {
          delete ret.createdAt
          delete ret.updatedAt
        } else if (typeof config === 'object' && config !== null) {
          const tsConfig = config as {
            createdAt?: string | boolean
            updatedAt?: string | boolean
          }
          if (tsConfig.createdAt) {
            delete ret[
              typeof tsConfig.createdAt === 'string'
                ? tsConfig.createdAt
                : 'createdAt'
            ]
          }

          if (tsConfig.updatedAt) {
            delete ret[
              typeof tsConfig.updatedAt === 'string'
                ? tsConfig.updatedAt
                : 'updatedAt'
            ]
          }
        }
      }
    })
  }

  // roll the document back to the state of a given patch id()
  schema.methods.rollback = function (
    this: PatchHistoryDocument,
    patchId: Types.ObjectId | string,
    data: Record<string, unknown> = {},
    save: boolean = true
  ): Promise<PatchHistoryDocument> {
    return this.patches
      .find({ ref: this._id })
      .sort({ date: 1 })
      .exec()
      .then(
        (patches: PatchData[]): Promise<PatchHistoryDocument> =>
          new Promise((resolve, reject) => {
            // patch doesn't exist
            const patchIds = patches.map((p) => p._id?.toString())
            if (!patchIds.includes(patchId.toString())) {
              return reject(new RollbackError("patch doesn't exist"))
            }

            // get all patches that should be applied
            const apply: PatchData[] = dropRightWhile(
              patches,
              (patch: PatchData): boolean =>
                patch._id?.toString() !== patchId.toString()
            )

            // if the patches that are going to be applied are all existing patches,
            // the rollback attempts to rollback to the latest patch
            if (patches.length === apply.length) {
              return reject(new RollbackError('rollback to latest patch'))
            }

            // apply patches to `state`
            const state: Record<string, unknown> = {}
            apply.forEach((patch: PatchData) => {
              // Cast to any for jsonpatch compatibility - the ops structure is correct
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              jsonpatch.applyPatch(state, patch.ops as any, true)
            })

            // set new state
            this.set(merge(data, state))

            // in case of save, save it back to the db and resolve
            if (save) {
              this.save().then(resolve).catch(reject)
            } else {
              resolve(this)
            }
          })
      )
  }

  // create patch model, enable static model access via `Patches` and
  // instance method access through an instances `patches` property
  const Patches: Model<PatchData> = createPatchModel(options)
  ;(schema.statics as Record<string, unknown>).Patches = Patches
  schema.virtual('patches').get(function (
    this: PatchHistoryDocument
  ): Model<PatchData> {
    return Patches
  })

  // after a document is initialized or saved, fresh snapshots of the
  // documents data are created
  const snapshot = function (this: PatchHistoryDocument): void {
    this._original = toJSON(this.data())
  }
  schema.post('init', snapshot)
  schema.post('save', snapshot)

  // when a document is removed and `removePatches` is not set to false ,
  // all patch documents from the associated patch collection are also removed
  async function deletePatches(document: PatchHistoryDocument): Promise<void> {
    const patches = await document.patches.find({ ref: document._id })
    await Promise.all(patches.map((patch) => patch.deleteOne()))
  }

  // Mongoose 9: pre middleware uses async functions instead of next()
  schema.pre(
    'deleteOne',
    { document: true, query: false },
    async function (this: PatchHistoryDocument) {
      if (!options.removePatches) {
        return
      }
      await deletePatches(this)
    }
  )

  // when a document is saved, the json patch that reflects the changes is
  // computed. if the patch consists of one or more operations (meaning the
  // document has changed), a new patch document reflecting the changes is
  // added to the associated patch collection
  async function createPatch(
    document: PatchHistoryDocument,
    queryOptions: Record<string, unknown> = {}
  ): Promise<void> {
    const { _id: ref } = document
    const compareResult = jsonpatch.compare(
      document._original || {},
      toJSON(document.data())
    )
    let ops: PatchOperation[] = compareResult.map((op) => {
      const patchOp: PatchOperation = {
        op: op.op as PatchOperation['op'],
        path: op.path
      }
      if ('value' in op) {
        patchOp.value = op.value
      }
      if ('from' in op) {
        patchOp.from = op.from
      }
      return patchOp
    })

    if (options.excludes.length > 0) {
      ops = ops.filter((op: PatchOperation): boolean => {
        const pathArray: string[] = getArrayFromPath(op.path)
        return (
          !options.excludes.some((exclude: string[]): boolean =>
            isPathContained(exclude, pathArray)
          ) &&
          options.excludes.every((exclude: string[]): boolean =>
            deepRemovePath(op, exclude)
          )
        )
      })
    }

    // don't save a patch when there are no changes to save
    if (!ops.length) {
      return
    }

    // track original values if enabled
    if (options.trackOriginalValue) {
      ops.forEach((entry: PatchOperation) => {
        const path: string = tail(entry.path.split('/')).join('.')
        entry.originalValue = get(
          document.isNew ? {} : document._original,
          path
        )
      })
    }

    // assemble patch data
    const docWithTimestamps = document as Document & {
      updatedAt?: Date
      createdAt?: Date
    }
    const data: PatchDataInput = {
      ops,
      ref,
      date:
        docWithTimestamps.updatedAt || docWithTimestamps.createdAt || new Date()
    }

    each(options.includes, (type: SchemaInclude, name: string) => {
      const fromKey = type.from || name
      data[name] =
        (document as unknown as Record<string, unknown>)[fromKey] ||
        (queryOptions as Record<string, unknown>)[fromKey]
    })

    await document.patches.create(data)
  }

  schema.pre('save', async function (this: PatchHistoryDocument) {
    await createPatch(this)
  })

  schema.pre(
    'findOneAndDelete',
    async function (this: Query<unknown, Document>) {
      if (!options.removePatches) {
        return
      }

      const session = this.getOptions().session
      const original = await this.model
        .findOne(this.getFilter())
        .session(session || null)

      if (original) {
        await deletePatches(original as unknown as PatchHistoryDocument)
      }
    }
  )

  async function preUpdateOne(this: UpdateQueryContext): Promise<void> {
    const session = this.getOptions().session

    const original = await this.model
      .findOne(this._conditions)
      .session(session || null)

    if (original) {
      this._originalId = original._id as Types.ObjectId
      this._original = toJSON(
        (original as unknown as PatchHistoryDocument).data()
      )
    }
  }

  schema.pre(
    'findOneAndUpdate',
    async function (this: Query<unknown, Document>) {
      await preUpdateOne.call(this as unknown as UpdateQueryContext)
    }
  )

  schema.post(
    'findOneAndUpdate',
    async function (this: Query<unknown, Document>, result: unknown) {
      await postUpdateOne.call(this as unknown as UpdateQueryContext, result)
    }
  )

  async function postUpdateOne(
    this: UpdateQueryContext,
    result: unknown
  ): Promise<void> {
    // result might be a mongodb ModifyResult, null or a Document
    const modifyResult = result as {
      lastErrorObject?: { n: number }
      upsertedCount?: number
    } | null
    if (
      modifyResult?.lastErrorObject?.n === 0 &&
      modifyResult?.upsertedCount === 0
    ) {
      return
    }

    let conditions: Record<string, unknown>
    if (this._originalId) {
      conditions = {
        _id: {
          $eq: this._originalId
        }
      }
    } else {
      conditions = mergeQueryConditionsWithUpdate(
        this._conditions,
        this._update
      )
    }

    const session = this.getOptions().session

    const doc = await this.model.findOne(conditions).session(session || null)

    if (doc) {
      (doc as unknown as PatchHistoryDocument)._original = this._original
      await createPatch(doc as unknown as PatchHistoryDocument, this.options)
    }
  }

  schema.pre('updateOne', async function (this: Query<unknown, Document>) {
    await preUpdateOne.call(this as unknown as UpdateQueryContext)
  })

  schema.post(
    'updateOne',
    async function (this: Query<unknown, Document>, result: unknown) {
      await postUpdateOne.call(this as unknown as UpdateQueryContext, result)
    }
  )

  async function preUpdateMany(this: UpdateQueryContext): Promise<void> {
    const session = this.getOptions().session

    const originals = await this.model
      .find(this._conditions)
      .session(session || null)

    const originalIds: Types.ObjectId[] = []
    const originalData: Record<string, unknown>[] = []
    for (const original of originals) {
      originalIds.push(original._id as Types.ObjectId)
      originalData.push(
        toJSON((original as unknown as PatchHistoryDocument).data())
      )
    }
    this._originalIds = originalIds
    this._originals = originalData
  }

  async function postUpdateMany(
    this: UpdateQueryContext,
    result: unknown
  ): Promise<void> {
    // result might be a mongodb ModifyResult, null or a Document
    const modifyResult = result as {
      lastErrorObject?: { n: number }
      upsertedCount?: number
    } | null
    if (
      modifyResult?.lastErrorObject?.n === 0 &&
      modifyResult?.upsertedCount === 0
    ) {
      return
    }

    let conditions: Record<string, unknown>
    if (this._originalIds && this._originalIds.length > 0) {
      conditions = { _id: { $in: this._originalIds } }
    } else {
      conditions = mergeQueryConditionsWithUpdate(
        this._conditions,
        this._update
      )
    }

    const session = this.getOptions().session

    const docs = await this.model.find(conditions).session(session || null)

    await Promise.all(
      docs.map((doc: Document, i: number) => {
        (doc as unknown as PatchHistoryDocument)._original =
          this._originals?.[i]
        return createPatch(doc as unknown as PatchHistoryDocument, this.options)
      })
    )
  }

  schema.pre('updateMany', async function (this: Query<unknown, Document>) {
    await preUpdateMany.call(this as unknown as UpdateQueryContext)
  })

  schema.post(
    'updateMany',
    async function (this: Query<unknown, Document>, result: unknown) {
      await postUpdateMany.call(this as unknown as UpdateQueryContext, result)
    }
  )
}
