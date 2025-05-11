import assert from 'assert'
import jsonpatch from 'fast-json-patch'
import {
  camelCase,
  dropRightWhile,
  each,
  get,
  map,
  merge,
  omit,
  snakeCase,
  tail
} from 'lodash'
import { Schema } from 'mongoose'
import { inherits } from 'util'

export class RollbackError extends Error {
  constructor(message: any) {
    super(message)
    this.name = 'RollbackError'
    Error.captureStackTrace(this, this.constructor)
  }
}

inherits(RollbackError, Error)

const createPatchModel = (options: any): any => {
  const def: any = {
    date: { type: Date, required: true, default: Date.now },
    ops: { type: [], required: true },
    ref: { type: options._idType, required: true, index: true }
  }

  each(options.includes, (type: any, name: any) => {
    def[name] = omit(type, 'from')
  })

  const PatchSchema: any = new Schema(def)

  return options.mongoose.model(
    options.transforms[0](`${options.name}`),
    PatchSchema,
    options.transforms[1](`${options.name}`)
  )
}

const defaultOptions: any = {
  includes: {},
  excludes: [],
  removePatches: true,
  transforms: [camelCase, snakeCase],
  trackOriginalValue: false
}

const ARRAY_INDEX_WILDCARD = '*'

/**
 * Splits a json-patch-path of form `/path/to/object` to an array `['path', 'to', 'object']`.
 * Note: `/` is returned as `[]`
 *
 * @param {string} path Path to split
 */
const getArrayFromPath = (path: string): string[] =>
  path.replace(/^\//, '').split('/')

/**
 * Checks the provided `json-patch-operation` on `excludePath`.
 * This check joins the `path` and `value` property of the `operation`
 * and removes any hit.
 *
 * @param {import('fast-json-patch').Operation} patch operation to check with `excludePath`
 * @param {String[]} excludePath Path to property to remove from value of `operation`
 *
 * @return `false` if `patch.value` is `{}` or `undefined` after remove, `true` in any other case
 */
const deepRemovePath = (patch: any, excludePath: string[]): boolean => {
  const operationPath: string[] = sanitizeEmptyPath(
    getArrayFromPath(patch.path)
  )

  if (isPathContained(operationPath, excludePath)) {
    let value: any = patch.value

    // because the paths overlap start at patchPath.length
    // e.g.: patch: { path:'/object', value:{ property: 'test' } }
    // pathToExclude: '/object/property'
    // need to start at array idx 1, because value starts at idx 0
    for (let i = operationPath.length; i < excludePath.length - 1; i++) {
      if (excludePath[i] === ARRAY_INDEX_WILDCARD && Array.isArray(value)) {
        // start over with each array element and make a fresh check
        // Note: it can happen that array elements are rendered to: {}
        //         we need to keep them to keep the order of array elements consistent
        value.forEach((elem: any) => {
          deepRemovePath({ path: '/', value: elem }, excludePath.slice(i + 1))
        })

        // If the patch value has turned to {} return false so this patch can be filtered out
        if (Object.keys(patch.value).length === 0) {
          return false
        }
        return true
      }
      value = value[excludePath[i]]

      if (typeof value === 'undefined') {
        return true
      }
    }
    if (typeof value[excludePath[excludePath.length - 1]] === 'undefined') {
      return true
    } else {
      delete value[excludePath[excludePath.length - 1]]
      // If the patch value has turned to {} return false so this patch can be filtered out
      if (Object.keys(patch.value).length === 0) {
        return false
      }
    }
  }

  return true
}

/**
 * Sanitizes a path `['']` to be used with `isPathContained()`
 * @param {String[]} path
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
const toJSON = (obj: any): any => JSON.parse(JSON.stringify(obj))

// helper function to merge query conditions after an update has happened
// useful if a property which was initially defined in _conditions got overwritten
// with the update
const mergeQueryConditionsWithUpdate = (
  _conditions: any,
  _update: any
): any => {
  const update: any = _update ? _update.$set || _update : _update
  const conditions: any = Object.assign({}, _conditions, update)

  // excluding updates other than $set
  Object.keys(conditions).forEach((key: string) => {
    if (key.includes('$')) {
      delete conditions[key]
    }
  })
  return conditions
}

export default function (schema: any, opts: any): void {
  const options: any = merge({}, defaultOptions, opts)

  // get _id type from schema
  options._idType = schema.tree._id.type

  // transform excludes option
  options.excludes = options.excludes.map(getArrayFromPath)

  // validate parameters
  assert(options.mongoose, '`mongoose` option must be defined')
  assert(options.name, '`name` option must be defined')
  assert(!schema.methods.data, 'conflicting instance method: `data`')
  assert(options._idType, 'schema is missing an `_id` property')

  // used to compare instance data snapshots. depopulates instance,
  // removes version key and object id
  schema.methods.data = function (this: any): any {
    return this.toObject({
      depopulate: true,
      versionKey: false,
      transform: (doc: any, ret: any /*, options: any*/) => {
        delete ret._id
        // if timestamps option is set on schema, ignore timestamp fields
        if (schema.options.timestamps) {
          delete ret[schema.options.timestamps.createdAt || 'createdAt']
          delete ret[schema.options.timestamps.updatedAt || 'updatedAt']
        }
      }
    })
  }

  // roll the document back to the state of a given patch id()
  schema.methods.rollback = function (
    this: any,
    patchId: any,
    data: any,
    save: boolean = true
  ): Promise<any> {
    return this.patches
      .find({ ref: this.id })
      .sort({ date: 1 })
      .exec()
      .then(
        (patches: any[]): Promise<any> =>
          new Promise((resolve: any, reject: any) => {
            // patch doesn't exist
            if (!~map(patches, 'id').indexOf(patchId)) {
              return reject(new RollbackError("patch doesn't exist"))
            }

            // get all patches that should be applied
            const apply: any[] = dropRightWhile(
              patches,
              (patch: any): boolean => patch.id !== patchId
            )

            // if the patches that are going to be applied are all existing patches,
            // the rollback attempts to rollback to the latest patch
            if (patches.length === apply.length) {
              return reject(new RollbackError('rollback to latest patch'))
            }

            // apply patches to `state`
            const state: any = {}
            apply.forEach((patch: any) => {
              jsonpatch.applyPatch(state, patch.ops, true)
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
  const Patches: any = createPatchModel(options)
  schema.statics.Patches = Patches
  schema.virtual('patches').get(function (this: any): any {
    return Patches
  })

  // after a document is initialized or saved, fresh snapshots of the
  // documents data are created
  const snapshot = function (this: any): void {
    this._original = toJSON(this.data())
  }
  schema.post('init', snapshot)
  schema.post('save', snapshot)

  // when a document is removed and `removePatches` is not set to false ,
  // all patch documents from the associated patch collection are also removed
  function deletePatches(document: any): Promise<any> {
    return document.patches
      .find({ ref: document._id })
      .then(
        (patches: any[]): Promise<any[]> =>
          Promise.all(patches.map((patch: any) => patch.remove()))
      )
  }

  schema.pre('remove', function (this: any, next: any): any {
    if (!options.removePatches) {
      return next()
    }

    deletePatches(this)
      .then(() => next())
      .catch(next)
  })

  // when a document is saved, the json patch that reflects the changes is
  // computed. if the patch consists of one or more operations (meaning the
  // document has changed), a new patch document reflecting the changes is
  // added to the associated patch collection
  function createPatch(document: any, queryOptions: any = {}): Promise<any> {
    const { _id: ref }: any = document
    let ops: any[] = jsonpatch.compare(
      document._original || {},
      toJSON(document.data())
    )
    if (options.excludes.length > 0) {
      ops = ops.filter((op: any): boolean => {
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
      return Promise.resolve()
    }

    // track original values if enabled
    if (options.trackOriginalValue) {
      ops.map((entry: any) => {
        const path: string = tail(entry.path.split('/')).join('.')
        entry.originalValue = get(
          document.isNew ? {} : document._original,
          path
        )
        return entry // Added return for .map
      })
    }

    // assemble patch data
    const data: any = {
      ops,
      ref,
      date: document.updatedAt || document.createdAt
    }

    each(options.includes, (type: any, name: string) => {
      data[name] =
        document[type.from || name] || queryOptions[type.from || name]
    })

    return document.patches.create(data)
  }

  schema.pre('save', function (this: any, next: any): any {
    createPatch(this)
      .then(() => next())
      .catch(next)
  })

  schema.pre('findOneAndRemove', function (this: any, next: any): any {
    if (!options.removePatches) {
      return next()
    }

    const session: any = this.getOptions().session

    this.model
      .findOne(this._conditions)
      .session(session)
      .then((original: any): Promise<any> | undefined => {
        // Added return type for .then callback
        if (!original) {
          return // Added check for original
        }
        return deletePatches(original)
      })
      .then(() => next())
      .catch(next)
  })

  schema.pre('findOneAndUpdate', preUpdateOne)

  function preUpdateOne(this: any, next: any): void {
    const session: any = this.getOptions().session

    this.model
      .findOne(this._conditions)
      .session(session)
      .then((original: any): void => {
        if (original) {
          this._originalId = original._id
          this._original = toJSON(original.data())
        }
      })
      .then(() => next())
      .catch(next)
  }

  schema.post(
    'findOneAndUpdate',
    function (this: any, doc: any, next: any): void {
      postUpdateOne.call(this, doc, next)
    }
  )

  function postUpdateOne(this: any, result: any, next: any): any {
    // result might be a mongodb ModifyResult, null or a Document
    if (result?.lastErrorObject?.n === 0 && result?.upsertedCount === 0) {
      return next()
    }

    let conditions: any
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

    const session: any = this.getOptions().session

    this.model
      .findOne(conditions)
      .session(session)
      .then((doc: any): Promise<any> | undefined => {
        if (!doc) {
          return
        }
        doc._original = this._original
        return createPatch(doc, this.options)
      })
      .then(() => next())
      .catch(next)
  }

  schema.pre('updateOne', preUpdateOne)
  schema.post('updateOne', postUpdateOne)

  function preUpdateMany(this: any, next: any): void {
    const session: any = this.getOptions().session

    this.model
      .find(this._conditions)
      .session(session)
      .then((originals: any[]): void => {
        const originalIds: any[] = []
        const originalData: any[] = []
        for (const original of originals) {
          originalIds.push(original._id)
          originalData.push(toJSON(original.data()))
        }
        this._originalIds = originalIds
        this._originals = originalData
      })
      .then(() => next())
      .catch(next)
  }

  function postUpdateMany(this: any, result: any, next: any): any {
    // result might be a mongodb ModifyResult, null or a Document
    if (result?.lastErrorObject?.n === 0 && result?.upsertedCount === 0) {
      return next()
    }

    let conditions: any
    if (this._originalIds && this._originalIds.length > 0) {
      // Added check for this._originalIds
      conditions = { _id: { $in: this._originalIds } }
    } else {
      conditions = mergeQueryConditionsWithUpdate(
        this._conditions,
        this._update
      )
    }

    const session: any = this.getOptions().session

    this.model
      .find(conditions)
      .session(session)
      .then(
        (docs: any[]): Promise<any[]> =>
          Promise.all(
            docs.map((doc: any, i: number) => {
              doc._original = this._originals[i]
              return createPatch(doc, this.options)
            })
          )
      )
      .then(() => next())
      .catch(next)
  }

  schema.pre('updateMany', preUpdateMany)
  schema.post('updateMany', postUpdateMany)

  schema.pre('update', function (this: any, next: any): void {
    if (this.options.multi) {
      preUpdateMany.call(this, next)
    } else {
      preUpdateOne.call(this, next)
    }
  })
  schema.post('update', function (this: any, result: any, next: any): void {
    if (this.options.multi) {
      postUpdateMany.call(this, result, next)
    } else {
      postUpdateOne.call(this, result, next)
    }
  })
}
