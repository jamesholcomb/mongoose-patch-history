import assert from 'assert'
import { map } from 'lodash'
import mongoose, { Document, Model, Schema, Types } from 'mongoose'
import patchHistory, { PatchHistoryOptions, RollbackError } from '../src'

// Type definitions for test models
interface CommentDocument extends Document {
  text: string
  user?: Types.ObjectId
  _user?: Types.ObjectId
  patches: Model<PatchDocument>
  data(): Record<string, unknown>
  rollback(
    patchId: Types.ObjectId | string,
    data?: Record<string, unknown>,
    save?: boolean
  ): Promise<CommentDocument>
}

interface PostDocument extends Document {
  title: string
  tags?: string[]
  active: boolean
  createdAt: Date
  updatedAt: Date
  __v: number
  __reason?: string
  __user?: { name: string }
  patches: Model<PatchDocument>
  data(): Record<string, unknown>
  rollback(
    patchId: Types.ObjectId | string,
    data?: Record<string, unknown>,
    save?: boolean
  ): Promise<PostDocument>
}

interface ExcludeDocument extends Document {
  name: string
  hidden?: string
  object?: {
    hiddenProperty?: string
    array?: Array<{
      hidden?: string
      property?: { hidden?: string }
    }>
  }
  array?: Array<{
    hiddenProperty?: string
    property?: string
  }>
  emptyArray?: Array<{ hiddenProperty?: string }>
  patches: Model<PatchDocument>
}

interface PricePoolDocument extends Document {
  name: string
  prices: Array<{ name: string; value: number }>
  patches: Model<PatchDocument>
}

interface CompanyDocument extends Document {
  name: string
  patches: Model<PatchDocument>
}

interface PersonDocument extends Document {
  name: string
  organization: Types.ObjectId
  patches: Model<PatchDocument>
}

interface OrganizationDocument extends Document {
  name: string
  text?: string
}

interface PatchDocument extends Document {
  date: Date
  ops: Array<{
    op: string
    path: string
    value?: unknown
    originalValue?: unknown
  }>
  ref: Types.ObjectId
  text?: string
  user?: Types.ObjectId | { name: string }
  version?: number
  reason?: string
}

interface PostModel extends Model<PostDocument> {
  Patches: Model<PatchDocument>
}

interface CommentModel extends Model<CommentDocument> {
  Patches: Model<PatchDocument>
}

interface ExcludeModel extends Model<ExcludeDocument> {
  Patches: Model<PatchDocument>
}

interface PricePoolModel extends Model<PricePoolDocument> {
  Patches: Model<PatchDocument>
}

interface CompanyModel extends Model<CompanyDocument> {
  Patches: Model<PatchDocument>
}

interface PersonModel extends Model<PersonDocument> {
  Patches: Model<PatchDocument>
}

describe('mongoose-patch-history', () => {
  const ObjectId = mongoose.Types.ObjectId
  const CommentSchema = new Schema<CommentDocument>({ text: String }).plugin(
    patchHistory,
    {
      mongoose: mongoose,
      name: 'commentPatches',
      removePatches: false,
      includes: {
        text: {
          type: String
        },
        user: {
          type: Schema.Types.ObjectId,
          required: true,
          from: '_user'
        }
      }
    }
  )

  CommentSchema.virtual('user').set(function (
    this: CommentDocument,
    user: Types.ObjectId
  ) {
    this._user = user
  })

  const PostSchema = new Schema<PostDocument>(
    {
      title: String,
      tags: { type: [String], default: void 0 },
      active: { type: Boolean, default: false }
    },
    { timestamps: true }
  ).plugin(patchHistory, {
    mongoose: mongoose,
    name: 'postPatches',
    transforms: [
      (name: string): string => name.toLowerCase(),
      (): string => 'post_history'
    ],
    includes: {
      version: { type: Number, from: '__v' },
      reason: { type: String, from: '__reason' },
      user: { type: Object, from: '__user' }
    }
  })
  PostSchema.virtual('user').set(function (
    this: PostDocument,
    user: { name: string }
  ) {
    this.__user = user
  })
  PostSchema.virtual('reason').set(function (
    this: PostDocument,
    reason: string
  ) {
    this.__reason = reason
  })

  const ExcludeSchema = new Schema<ExcludeDocument>({
    name: { type: String },
    hidden: { type: String },
    object: {
      hiddenProperty: { type: String },
      array: [
        {
          hidden: { type: String },
          property: { hidden: { type: String } }
        }
      ]
    },
    array: [
      {
        hiddenProperty: { type: String },
        property: { type: String }
      }
    ],
    emptyArray: [{ hiddenProperty: { type: String } }]
  }).plugin(patchHistory, {
    mongoose: mongoose,
    name: 'excludePatches',
    excludes: [
      '/hidden',
      '/object/hiddenProperty',
      '/object/array/1/hidden',
      '/object/array/*/property/hidden',
      '/array/*/hiddenProperty',
      '/emptyArray/*/hiddenProperty'
    ]
  })

  const PricePoolSchema = new Schema<PricePoolDocument>({
    name: { type: String },
    prices: [{ name: { type: String }, value: { type: Number } }]
  }).plugin(patchHistory, {
    mongoose: mongoose,
    name: 'pricePoolPatches',
    trackOriginalValue: true
  })

  let Comment: CommentModel,
    Post: PostModel,
    User: Model<Document>,
    PricePool: PricePoolModel,
    Exclude: ExcludeModel

  before((done) => {
    mongoose
      .connect(
        'mongodb://root:root@localhost:27017/mongoose-patch-history?&authSource=admin&directConnection=true'
      )
      .then(({ connection }) => {
        if (!connection.db) {
          throw new Error('Database connection not established')
        }
        connection.db
          .dropDatabase()
          .then(() => {
            Comment = mongoose.model<CommentDocument, CommentModel>(
              'Comment',
              CommentSchema
            )
            Post = mongoose.model<PostDocument, PostModel>('Post', PostSchema)
            User = mongoose.model<Document>('User', new Schema({}))
            PricePool = mongoose.model<PricePoolDocument, PricePoolModel>(
              'PricePool',
              PricePoolSchema
            )
            Exclude = mongoose.model<ExcludeDocument, ExcludeModel>(
              'Exclude',
              ExcludeSchema
            )
          })
          .finally(() => done())
      })
  })

  after((done) => {
    mongoose.connection.close().then(() => done())
  })

  describe('initialization', () => {
    const name = 'testPatches'
    let TestSchema: Schema

    before(() => {
      TestSchema = new Schema()
    })

    it('throws when `mongoose` option is not defined', () => {
      assert.throws(() =>
        TestSchema.plugin(patchHistory, { name } as PatchHistoryOptions)
      )
    })

    it('throws when `name` option is not defined', () => {
      assert.throws(() =>
        TestSchema.plugin(patchHistory, {
          mongoose: mongoose
        } as PatchHistoryOptions)
      )
    })

    it('throws when `data` instance method exists', () => {
      const DataSchema = new Schema()
      DataSchema.methods.data = (): Record<string, unknown> => ({})
      assert.throws(() =>
        DataSchema.plugin(patchHistory, {
          mongoose: mongoose,
          name
        })
      )
    })

    it('does not throw with valid parameters', () => {
      assert.doesNotThrow(() =>
        TestSchema.plugin(patchHistory, {
          mongoose: mongoose,
          name
        })
      )
    })
  })

  describe('saving a new document', () => {
    it('adds a patch', (done) => {
      Promise.all([
        // without referenced user
        Post.create({ title: 'foo' })
          .then((post) => post.patches.find({ ref: post._id }))
          .then((patches) => {
            assert.equal(patches.length, 1)
            assert.equal(
              JSON.stringify(patches[0].ops),
              JSON.stringify([
                { op: 'add', path: '/title', value: 'foo' },
                { op: 'add', path: '/active', value: false }
              ])
            )
          }),
        // with referenced user
        User.findOne()
          .then(() =>
            Comment.create({
              text: 'wat',
              user: new ObjectId()
            })
          )
          .then((comment) => comment.patches.find({ ref: comment._id }))
          .then((patches) => {
            assert.equal(patches.length, 1)
            assert.equal(
              JSON.stringify(patches[0].ops),
              JSON.stringify([{ op: 'add', path: '/text', value: 'wat' }])
            )
          })
      ])
        .then(() => done())
        .catch(done)
    })

    describe('with exclude options', () => {
      it('adds a patch containing no excluded properties', (done) => {
        Exclude.create({
          name: 'exclude1',
          hidden: 'hidden',
          object: {
            hiddenProperty: 'hidden',
            array: [
              { hidden: 'h', property: { hidden: 'h' } },
              { hidden: 'h', property: { hidden: 'h' } },
              { hidden: 'h', property: { hidden: 'h' } }
            ]
          },
          array: [
            { hiddenProperty: 'hidden', property: 'visible' },
            { hiddenProperty: 'hidden', property: 'visible' }
          ],
          emptyArray: [{ hiddenProperty: 'hidden' }]
        })
          .then((exclude) => exclude.patches.find({ ref: exclude._id }))
          .then((patches) => {
            assert.equal(patches.length, 1)
            assert.equal(
              JSON.stringify(patches[0].ops),
              JSON.stringify([
                { op: 'add', path: '/name', value: 'exclude1' },
                {
                  op: 'add',
                  path: '/object',
                  value: { array: [{ hidden: 'h' }, {}, { hidden: 'h' }] }
                },
                {
                  op: 'add',
                  path: '/array',
                  value: [{ property: 'visible' }, { property: 'visible' }]
                },
                { op: 'add', path: '/emptyArray', value: [{}] }
              ])
            )
          })
          .then(() => done())
          .catch(done)
      })
    })
  })

  describe('saving an existing document', () => {
    it('with changes: adds a patch', (done) => {
      Post.findOne({ title: 'foo' })
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          post.set({
            title: 'bar',
            reason: 'test reason',
            user: { name: 'Joe' }
          })
          return post.save()
        })
        .then((post) => post.patches.find({ ref: post._id }).sort({ _id: 1 }))
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([{ op: 'replace', path: '/title', value: 'bar' }])
          )
          assert.equal(patches[1].reason, 'test reason')
          assert.equal((patches[1].user as { name: string })?.name, 'Joe')
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done) => {
      Post.create({ title: 'baz' })
        .then((post) => post.save())
        .then((post) => post.patches.find({ ref: post._id }))
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('with changes covered by exclude: does not add a patch', (done) => {
      Exclude.findOne({ name: 'exclude1' })
        .then((exclude) => {
          if (!exclude) {
            throw new Error('Exclude not found')
          }
          if (exclude.object) {
            exclude.object.hiddenProperty = 'test'
          }
          if (exclude.array && exclude.array[0]) {
            exclude.array[0].hiddenProperty = 'test'
          }
          return exclude.save()
        })
        .then((exclude) => exclude.patches.find({ ref: exclude._id }))
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(() => done())
        .catch(done)
    })
  })

  describe('updating a document via findOneAndUpdate()', () => {
    it('upserts a new document', (done) => {
      Post.findOneAndUpdate(
        { title: 'doesNotExist' },
        { title: 'findOneAndUpdate' },
        {
          upsert: true,
          new: true
        }
      )
        .then(() => Post.findOne({ title: 'findOneAndUpdate' }))
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 1)
          assert.equal(
            JSON.stringify(patches[0].ops),
            JSON.stringify([
              { op: 'add', path: '/title', value: 'findOneAndUpdate' },
              { op: 'add', path: '/active', value: false }
            ])
          )
        })
        .then(done)
        .catch(done)
    })

    it('with changes: adds a patch', (done) => {
      Post.create({ title: 'findOneAndUpdate1' })
        .then((post) =>
          Post.findOneAndUpdate(
            { _id: post._id },
            { title: 'findOneAndUpdate2', __v: 1 },
            { __reason: 'test reason', __user: { name: 'Joe' } }
          )
        )
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([
              { op: 'replace', path: '/title', value: 'findOneAndUpdate2' }
            ])
          )
          assert.equal(patches[1].reason, 'test reason')
          assert.equal((patches[1].user as { name: string })?.name, 'Joe')
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done) => {
      Post.findOneAndUpdate({ title: 'baz' }, {})
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id })
        })
        .then((patches) => assert.equal(patches.length, 1))
        .then(done)
        .catch(done)
    })

    it('should not throw "TypeError: Cannot set property _original of null" error if doc does not exist', async (): Promise<void> => {
      await Post.findOneAndUpdate(
        { title: 'the_answer_to_life' },
        { title: '42', comments: 'thanks for all the fish' }
      )
        .then((post) => assert.strictEqual(post, null))
        .catch((e: Error) => assert.fail(e.message))
    })

    it('with options: { new: true }', async (): Promise<void> => {
      const title = 'findOneAndUpdateNewTrue'
      await Post.create({ title })
      await Post.findOneAndUpdate({ title }, { title: 'baz' }, { new: true })
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id })
        })
        .then((patches) => assert.strictEqual(patches.length, 2))
        .catch((e: Error) => assert.fail(e.message))
    })

    it('with options: { includeResultMetadata: true }', async (): Promise<void> => {
      const title = 'findOneAndUpdateIncludeResultMetadataTrue'
      await Post.create({ title })
      await Post.findOneAndUpdate(
        { title },
        { title: 'baz' },
        { includeResultMetadata: true }
      )
        .then((result) => {
          const modifyResult = result
          if (!modifyResult.value) {
            throw new Error('Post not found')
          }
          return modifyResult.value.patches.find({
            ref: modifyResult.value._id
          })
        })
        .then((patches) => assert.strictEqual(patches.length, 2))
        .catch((e: Error) => assert.fail(e.message))
    })
  })

  describe('updating a document via updateOne()', () => {
    it('with changes: adds a patch', (done) => {
      Post.create({ title: 'updateOne1' })
        .then((post) =>
          Post.updateOne({ _id: post._id }, { title: 'updateOne2' })
        )
        .then(() => Post.findOne({ title: 'updateOne2' }))
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([
              { op: 'replace', path: '/title', value: 'updateOne2' }
            ])
          )
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done) => {
      Post.updateOne({ title: 'baz' }, {})
        .then(() => Post.findOne({ title: 'baz' }))
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id })
        })
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('handles array filters', (done) => {
      PricePool.create({
        name: 'test',
        prices: [
          { name: 'test1', value: 1 },
          { name: 'test2', value: 2 }
        ]
      })
        .then((pricePool) =>
          PricePool.updateMany(
            { name: pricePool.name },
            { $set: { 'prices.$[elem].value': 3 } },
            { arrayFilters: [{ 'elem.name': { $eq: 'test1' } }] }
          )
        )
        .then(() => PricePool.Patches.find({}))
        .then((patches) => {
          assert.equal(patches.length, 2)
        })
        .then(done)
        .catch(done)
    })
  })

  describe('updating a document via updateMany()', () => {
    it('with changes: adds a patch', (done) => {
      Post.create({ title: 'updateMany1' })
        .then((post) =>
          Post.updateMany({ _id: post._id }, { title: 'updateMany2' })
        )
        .then(() => Post.find({ title: 'updateMany2' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([
              { op: 'replace', path: '/title', value: 'updateMany2' }
            ])
          )
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done) => {
      Post.updateMany({ title: 'baz' }, {})
        .then(() => Post.find({ title: 'baz' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id })
        })
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('handles the $push operator', (done) => {
      Post.create({ title: 'tagged1', tags: ['match'] })
        .then((post) =>
          Post.updateMany(
            { _id: post._id },
            { $push: { tags: 'match2' } },
            { timestamps: false }
          )
        )
        .then(() => Post.find({ title: 'tagged1' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([{ op: 'add', path: '/tags/1', value: 'match2' }])
          )
        })
        .then(() => done())
        .catch(done)
    })

    it('handles the $pull operator', (done) => {
      Post.create({ title: 'tagged2', tags: ['match'] })
        .then(() =>
          // Remove the 'match' tag from all posts tagged with 'match'
          Post.updateMany(
            { tags: 'match' },
            { $pull: { tags: 'match' } },
            { timestamps: false }
          )
        )
        .then(() => Post.find({ title: 'tagged2' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([{ op: 'remove', path: '/tags/0' }])
          )
        })
        .then(() => done())
        .catch(done)
    })
  })

  describe('upsert a document', () => {
    it('with changes: adds a patch', (done) => {
      Post.updateMany(
        { title: 'upsert0' },
        { title: 'upsert1' },
        { upsert: true }
      )
        .then(() => Post.find({ title: 'upsert1' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        })
        .then((patches) => {
          assert.equal(patches.length, 1)
          assert.equal(
            JSON.stringify(patches[0].ops),
            JSON.stringify([
              { op: 'add', path: '/title', value: 'upsert1' },
              { op: 'add', path: '/active', value: false }
            ])
          )
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done) => {
      Post.updateMany(
        { title: 'upsert1' },
        { title: 'upsert1' },
        { upsert: true }
      )
        .then(() => Post.find({ title: 'upsert1' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id })
        })
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('with updateMany: adds a patch', (done) => {
      Post.updateMany(
        { title: 'upsert2' },
        { title: 'upsert3' },
        { upsert: true }
      )
        .then(() => Post.find({ title: 'upsert3' }))
        .then((posts) => {
          if (!posts[0]) {
            throw new Error('Post not found')
          }
          return posts[0].patches.find({ ref: posts[0]._id })
        })
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })
  })

  describe('update with multi', () => {
    it('should not throw "TypeError: Cannot set property _original of null" error if doc does not exist', (done) => {
      Post.updateMany(
        { title: { $in: ['foo_bar'] } },
        { title: 'bar_foo' },
        { upsert: false }
      )
        .then(() => done())
        .catch(done)
    })
  })

  describe('removing a document', () => {
    it('removes all patches', (done) => {
      Post.findOne({ title: 'bar' })
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.deleteOne().then(() => post)
        })
        .then((post) => post.patches.find({ ref: post._id }))
        .then((patches) => {
          assert.equal(patches.length, 0)
        })
        .then(done)
        .catch(done)
    })
    it("doesn't remove patches when `removePatches` is false", (done) => {
      Comment.findOne({ text: 'wat' })
        .then((comment) => {
          if (!comment) {
            throw new Error('Comment not found')
          }
          return comment.deleteOne().then(() => comment)
        })
        .then((comment) => comment.patches.find({ ref: comment._id }))
        .then((patches) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })
    it('removes all patches via findOneAndDelete()', (done) => {
      Post.create({ title: 'findOneAndDelete1' })
        .then((post) => Post.findOneAndDelete({ _id: post._id }))
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches.find({ ref: post._id })
        })
        .then((patches) => {
          assert.equal(patches.length, 0)
        })
        .then(done)
        .catch(done)
    })
  })
  describe('rollback', () => {
    it('with unknown id is rejected', (done) => {
      Post.create({ title: 'version 1' }).then((post) => {
        return post
          .rollback(new ObjectId())
          .then(() => {
            done()
          })
          .catch((err: Error) => {
            assert(err instanceof RollbackError)
            done()
          })
      })
    })

    it('to latest patch is rejected', (done) => {
      Post.create({ title: 'version 1' })
        .then((post) =>
          Promise.all([post, post.patches.findOne({ ref: post._id })])
        )
        .then(([post, latestPatch]) => {
          if (!latestPatch) {
            throw new Error('Patch not found')
          }
          return post
            .rollback(latestPatch._id)
            .then(() => {
              done()
            })
            .catch((err: Error) => {
              assert(err instanceof RollbackError)
              done()
            })
        })
    })

    it('adds a new patch and updates the document', (done) => {
      Comment.create({ text: 'comm 1', user: new ObjectId() })
        .then((c) => Comment.findOne({ _id: c._id }))
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          return c.set({ text: 'comm 2', user: new ObjectId() }).save()
        })
        .then((c) => Comment.findOne({ _id: c._id }))
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          return c.set({ text: 'comm 3', user: new ObjectId() }).save()
        })
        .then((c) => Comment.findOne({ _id: c._id }))
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          return Promise.all([c, c.patches.find({ ref: c._id })])
        })
        .then(([c, patches]) =>
          c.rollback(patches[1]._id, { user: new ObjectId() })
        )
        .then((c) => {
          assert.equal(c.text, 'comm 2')
          return c.patches.find({ ref: c._id })
        })
        .then((patches) => assert.equal(patches.length, 4))
        .then(done)
        .catch(done)
    })

    it("updates but doesn't save the document", (done) => {
      Comment.create({ text: 'comm 1', user: new ObjectId() })
        .then((c) => Comment.findOne({ _id: c._id }))
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          return c.set({ text: 'comm 2', user: new ObjectId() }).save()
        })
        .then((c) => Comment.findOne({ _id: c._id }))
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          return c.set({ text: 'comm 3', user: new ObjectId() }).save()
        })
        .then((c) => Comment.findOne({ _id: c._id }))
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          return Promise.all([c, c.patches.find({ ref: c._id })])
        })
        .then(([c, patches]) =>
          c.rollback(patches[1]._id, { user: new ObjectId() }, false)
        )
        .then((c) => {
          assert.equal(c.text, 'comm 2')
          return Comment.findOne({ _id: c._id })
        })
        .then((c) => {
          if (!c) {
            throw new Error('Comment not found')
          }
          assert.equal(c.text, 'comm 3')
          return c.patches.find({ ref: c._id })
        })
        .then((patches) => assert.equal(patches.length, 3))
        .then(done)
        .catch(done)
    })
  })

  describe('model and collection names', () => {
    const getCollectionNames = (): Promise<string[]> => {
      return new Promise((resolve, reject) => {
        const db = mongoose.connection.db
        if (!db) {
          return reject(new Error('Database connection not established'))
        }
        db.listCollections()
          .toArray()
          .then((collections) => {
            resolve(map(collections, 'name') as string[])
          })
          .catch(reject)
      })
    }

    it('pascalize for model and decamelize for collection', (done) => {
      Promise.all([
        () => assert(!!~mongoose.modelNames().indexOf('CommentPatches')),
        getCollectionNames().then((names) => {
          assert(!!~names.indexOf('comment_patches'))
        })
      ])
        .then(() => done())
        .catch(done)
    })

    it('uses `transform` option when set', (done) => {
      Promise.all([
        () => assert(!!~mongoose.modelNames().indexOf('postPatches')),
        getCollectionNames().then((names) => {
          assert(!!~names.indexOf('post_history'))
        })
      ])
        .then(() => done())
        .catch(done)
    })
  })

  describe('timestamps', () => {
    it('creates doc and sets mongoose timestamp fields', (done) => {
      Post.create({ title: 'ts1' })
        .then((post) =>
          post.patches
            .find({ ref: post._id })
            .sort({ _id: 1 })
            .then((patches) => {
              assert.equal(patches.length, 1)
              assert.equal(
                patches[0].date.toUTCString(),
                post.createdAt.toUTCString()
              )
              assert.equal(
                patches[0].date.toUTCString(),
                post.updatedAt.toUTCString()
              )
            })
        )
        .then(done)
        .catch(done)
    })

    it('updates doc and sets mongoose timestamp fields', (done) => {
      Post.create({ title: 'ts2' })
        .then(({ _id }) =>
          Post.updateOne({ _id }, { $set: { title: 'ts2.1' } })
        )
        .then(() => Post.findOne({ title: 'ts2.1' }))
        .then((post) => {
          if (!post) {
            throw new Error('Post not found')
          }
          return post.patches
            .find({ ref: post._id })
            .sort({ _id: 1 })
            .then((patches) => {
              assert.equal(patches.length, 2)
              assert.equal(
                patches[0].date.toUTCString(),
                post.createdAt.toUTCString()
              )
              assert.equal(
                patches[1].date.toUTCString(),
                post.updatedAt.toUTCString()
              )
            })
        })
        .then(done)
        .catch(done)
    })
  })

  describe('jsonpatch.compare', () => {
    let Organization: Model<OrganizationDocument>
    let Person: PersonModel

    before(() => {
      Organization = mongoose.model<OrganizationDocument>(
        'Organization',
        new mongoose.Schema({
          name: String
        })
      )

      const PersonSchema = new mongoose.Schema<PersonDocument>({
        name: String,
        organization: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Organization'
        }
      })

      PersonSchema.plugin(patchHistory, {
        mongoose: mongoose,
        name: 'personPatches'
      })
      Person = mongoose.model<PersonDocument, PersonModel>(
        'Person',
        PersonSchema
      )
    })

    it('is able to handle ObjectId references correctly', (done) => {
      Organization.create({ text: 'Home' })
        .then((o1) => Promise.all([o1, Organization.create({ text: 'Work' })]))
        .then(([o1, o2]) =>
          Promise.all([
            o1,
            o2,
            Person.create({ name: 'Bob', organization: o1._id })
          ])
        )
        .then(([o1, o2, p]) =>
          Promise.all([o1, o2, p.set({ organization: o2._id }).save()])
        )
        .then(([o1, o2, p]) =>
          Promise.all([o1, o2, p.patches.find({ ref: p._id })])
        )
        .then(([o1, o2, patches]) => {
          const pathFilter =
            (path: string) =>
            (elem: { path: string }): boolean =>
              elem.path === path
          const firstOrganizationOperation = patches[0].ops.find(
            pathFilter('/organization')
          )
          const secondOrganizationOperation = patches[1].ops.find(
            pathFilter('/organization')
          )
          assert.deepStrictEqual(
            firstOrganizationOperation?.value?.toString(),
            o1._id.toString()
          )
          assert.deepStrictEqual(
            secondOrganizationOperation?.value?.toString(),
            o2._id.toString()
          )
        })
        .then(done)
        .catch(done)
    })
  })

  describe('track original values', () => {
    let Company: CompanyModel

    before(() => {
      const CompanySchema = new mongoose.Schema<CompanyDocument>({
        name: String
      })

      CompanySchema.plugin(patchHistory, {
        mongoose: mongoose,
        name: 'companyPatches',
        trackOriginalValue: true
      })
      Company = mongoose.model<CompanyDocument, CompanyModel>(
        'Company',
        CompanySchema
      )
    })

    after((done) => {
      Promise.all([Company.deleteMany(), Company.Patches.deleteMany()]).then(
        () => done()
      )
    })

    it('stores the original value in the ops entries', (done) => {
      Company.create({ name: 'Private' })
        .then((c) => c.set({ name: 'Private 2' }).save())
        .then((c) => c.set({ name: 'Private 3' }).save())
        .then((c) => c.patches.find().sort({ _id: 1 }))
        .then((patches) => {
          assert.equal(patches.length, 3)
          assert.equal(
            JSON.stringify(patches[1].ops), // First update patch
            JSON.stringify([
              {
                op: 'replace',
                path: '/name',
                value: 'Private 2',
                originalValue: 'Private'
              }
            ])
          )
          assert.equal(
            JSON.stringify(patches[2].ops), // Second update patch
            JSON.stringify([
              {
                op: 'replace',
                path: '/name',
                value: 'Private 3',
                originalValue: 'Private 2'
              }
            ])
          )
        })
        .then(done)
    })
  })

  describe('concurrent updates', () => {
    it('handles concurrent updates gracefully using withTransaction', async function () {
      const post = await Post.create({ title: 'concurrent' })
      let successCount = 0
      let failureCount = 0
      const iterations = 5

      // Attempt 5 concurrent transactions
      await Promise.all(
        Array.from({ length: iterations }).map(async (_, i) => {
          const session = await mongoose.startSession()
          try {
            await session.withTransaction(async () => {
              const p = await Post.findOne({ _id: post._id }).session(session)
              if (!p) {
                throw new Error('Post not found')
              }
              p.title = `concurrent update ${i}`
              await p.save()
            })
            successCount++
          } catch (err: any) {
            if (err instanceof mongoose.mongo.MongoError && err.code === 251) {
              // withTransaction retries TransientTransactionError, but if it eventually fails or hits other errors:
              failureCount++
            }
          } finally {
            await session.endSession()
          }
        })
      )

      // 5 attempts, should be 5 total
      assert.equal(successCount + failureCount, iterations)
      // At least one should succeed
      assert.ok(successCount > 0, 'At least one update should succeed')

      // Verify patches
      // Since we used transactions, if a transaction committed, the patch must be there.
      // If it aborted, the patch must NOT be there.
      const patches = await post.patches.find({ ref: post._id })
      // +1 for creation
      assert.equal(patches.length, successCount + 1)
    })

    it('handles concurrent updates within a single transaction', async function () {
      const post = await Post.create({ title: 'concurrent' })
      let successCount = 0
      const iterations = 5

      // Attempt 5 concurrent updates within a single transaction
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          for (let i = 0; i < iterations; i++) {
            const p = await Post.findOne({ _id: post._id }).session(session)
            if (!p) {
              throw new Error('Post not found')
            }
            p.title = `concurrent update ${i}`
            await p.save()
            successCount++
          }
        })
      } finally {
        await session.endSession()
      }

      // At least one should succeed
      assert.equal(successCount, iterations, 'All updates should succeed')

      // Verify patches
      // Since we used transactions, if a transaction committed, the patches must be there.
      // If it aborted, the patches must NOT be there.
      const patches = await post.patches.find({ ref: post._id })

      // +1 for creation, +5 for the updates in the loop
      assert.equal(patches.length, successCount + 1)
    })
  })
})
