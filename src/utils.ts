import { PatchOperation } from './types'

const ARRAY_INDEX_WILDCARD = '*'

/**
 * Splits a json-patch-path of form `/path/to/object` to an array `['path', 'to', 'object']`.
 * Note: `/` is returned as `[]`
 *
 * @param path Path to split
 */
export const getArrayFromPath = (path: string): string[] =>
  path.replace(/^\//, '').split('/')

/**
 * Sanitizes a path `['']` to be used with `isPathContained()`
 * @param path
 */
export const sanitizeEmptyPath = (path: string[]): string[] =>
  path.length === 1 && path[0] === '' ? [] : path

const isIntegerGreaterEqual0 = (entry: string): boolean =>
  Number.isInteger(Number(entry)) && Number(entry) >= 0

const isArrayIndexWildcard = (entry: string): boolean =>
  entry === ARRAY_INDEX_WILDCARD

const matchesArrayWildcard = (entry1: string, entry2: string): boolean =>
  isArrayIndexWildcard(entry1) && isIntegerGreaterEqual0(entry2)

const entryIsIdentical = (entry1: string, entry2: string): boolean =>
  entry1 === entry2

// Checks if 'fractionPath' is contained in fullPath
// Exp. 1: fractionPath '/path/to',              fullPath '/path/to/object'       => true
// Exp. 2: fractionPath '/arrayPath/*/property', fullPath '/arrayPath/1/property' => true
export const isPathContained = (
  fractionPath: string[],
  fullPath: string[]
): boolean =>
  fractionPath.every(
    (entry: string, idx: number) =>
      entryIsIdentical(entry, fullPath[idx]) ||
      matchesArrayWildcard(entry, fullPath[idx])
  )

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
export const deepRemovePath = (
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
        const arrayValue = value as unknown[]
        arrayValue.forEach((elem: unknown) => {
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

// used to convert bson to json - especially ObjectID references need
// to be converted to hex strings so that the jsonpatch `compare` method
// works correctly
export const toJSON = <T>(obj: T): T => JSON.parse(JSON.stringify(obj))

// helper function to merge query conditions after an update has happened
// useful if a property which was initially defined in _conditions got overwritten
// with the update
export const mergeQueryConditionsWithUpdate = (
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
