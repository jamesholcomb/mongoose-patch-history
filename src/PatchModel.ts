import { each, omit } from 'lodash'
import { Model, Schema, SchemaDefinitionProperty } from 'mongoose'
import { PatchData, ResolvedOptions, SchemaInclude } from './types'

export const createPatchModel = (
  options: ResolvedOptions
): Model<PatchData> => {
  const def: Record<string, SchemaDefinitionProperty> = {
    date: { type: Date, required: true, default: Date.now },
    ops: { type: [], required: true },
    ref: { type: options._idType, required: true, index: true }
  }

  each(options.includes, (type: SchemaInclude, name: string) => {
    def[name] = omit(type, 'from') as SchemaDefinitionProperty
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const PatchSchema = new Schema<PatchData>(def as any)

  return options.mongoose.model<PatchData>(
    options.transforms[0](`${options.name}`),
    PatchSchema,
    options.transforms[1](`${options.name}`)
  )
}
