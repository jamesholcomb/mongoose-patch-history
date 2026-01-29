import assert from 'assert'
import jsonpatch from 'fast-json-patch'
import {
  camelCase,
  dropRightWhile,
  each,
  get,
  merge,
  snakeCase,
  tail
} from 'lodash'
import { Document, Model, Query, Schema, Types } from 'mongoose'
import { inherits } from 'util'

import { createPatchModel } from './PatchModel'
import {
  PatchData,
  PatchDataInput,
  PatchHistoryDocument,
  PatchHistoryOptions,
  PatchOperation,
  ResolvedOptions,
  SchemaInclude,
  UpdateQueryContext
} from './types'
import {
  deepRemovePath,
  getArrayFromPath,
  isPathContained,
  mergeQueryConditionsWithUpdate,
  toJSON
} from './utils'

// Re-export types
export * from './types'

// Error Class
export class RollbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RollbackError'
    Error.captureStackTrace(this, this.constructor)
  }
}

inherits(RollbackError, Error)

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
    const session = document.$session()
    const patches = await document.patches
      .find({ ref: document._id })
      .session(session || null)
    await Promise.all(
      patches.map((patch) => patch.deleteOne(session ? { session } : undefined))
    )
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

    // create the patch with the same session as the document
    if (document.$session()) {
      await document.patches.create([data], { session: document.$session() })
    } else {
      await document.patches.create(data)
    }
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
