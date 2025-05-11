import assert from 'assert'
import { map, random } from 'lodash'
import mongoose, { Schema } from 'mongoose'
import patchHistory, { RollbackError } from '../src'

describe('mongoose-patch-history', () => {
  const ObjectId: any = mongoose.Types.ObjectId
  const CommentSchema: any = new Schema({ text: String }).plugin(patchHistory, {
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
  })

  CommentSchema.virtual('user').set(function (this: any, user: any) {
    this._user = user
  })

  const PostSchema: any = new Schema(
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
      (name: any): any => name.toLowerCase(),
      (): any => 'post_history'
    ],
    includes: {
      version: { type: Number, from: '__v' },
      reason: { type: String, from: '__reason' },
      user: { type: Object, from: '__user' }
    }
  })
  PostSchema.virtual('user').set(function (this: any, user: any) {
    this.__user = user
  })
  PostSchema.virtual('reason').set(function (this: any, reason: any) {
    this.__reason = reason
  })

  const FruitSchema: any = new Schema({
    _id: { type: String, default: random(100).toString() },
    name: { type: String }
  }).plugin(patchHistory, {
    mongoose: mongoose,
    name: 'fruitPatches'
  })

  const ExcludeSchema: any = new Schema({
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

  const SportSchema: any = new Schema({
    _id: { type: Number, default: random(100) },
    name: { type: String }
  }).plugin(patchHistory, {
    mongoose: mongoose,
    name: 'sportPatches'
  })

  const PricePoolSchema: any = new Schema({
    name: { type: String },
    prices: [{ name: { type: String }, value: { type: Number } }]
  }).plugin(patchHistory, {
    mongoose: mongoose,
    name: 'pricePoolPatches',
    trackOriginalValue: true
  })

  let Comment: any,
    Post: any,
    Fruit: any,
    Sport: any,
    User: any,
    PricePool: any,
    Exclude: any
  before((done: any) => {
    mongoose
      .connect(
        'mongodb://root:root@localhost:27017/mongoose-patch-history?&authSource=admin&directConnection=true'
      )
      .then(({ connection }: { connection: any }) => {
        connection.db
          .dropDatabase()
          .then(() => {
            Comment = mongoose.model('Comment', CommentSchema)
            Post = mongoose.model('Post', PostSchema)
            Fruit = mongoose.model('Fruit', FruitSchema)
            Sport = mongoose.model('Sport', SportSchema)
            User = mongoose.model('User', new Schema({}))
            PricePool = mongoose.model('PricePool', PricePoolSchema)
            Exclude = mongoose.model('Exclude', ExcludeSchema)
          })
          .finally(() => done())
      })
  })

  after((done: any) => {
    mongoose.connection.close().then(() => done())
  })

  describe('initialization', () => {
    const name: any = 'testPatches'
    let TestSchema: any

    before(() => {
      TestSchema = new Schema()
    })

    it('throws when `mongoose` option is not defined', () => {
      assert.throws(() => TestSchema.plugin(patchHistory, { name }))
    })

    it('throws when `name` option is not defined', () => {
      assert.throws(() =>
        TestSchema.plugin(patchHistory, { mongoose: mongoose })
      )
    })

    it('throws when `data` instance method exists', () => {
      const DataSchema: any = new Schema()
      DataSchema.methods.data = (): any => {}
      assert.throws(() =>
        DataSchema.plugin(patchHistory, { mongoose: mongoose, name })
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
    it('adds a patch', (done: any) => {
      Promise.all([
        // without referenced user
        Post.create({ title: 'foo' })
          .then((post: any) => post.patches.find({ ref: post.id }))
          .then((patches: any) => {
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
          .then((comment: any) => comment.patches.find({ ref: comment.id }))
          .then((patches: any) => {
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
      it('adds a patch containing no excluded properties', (done: any) => {
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
          .then((exclude: any) => exclude.patches.find({ ref: exclude._id }))
          .then((patches: any) => {
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
    it('with changes: adds a patch', (done: any) => {
      Post.findOne({ title: 'foo' })
        .then((post: any) => {
          post.set({
            title: 'bar',
            reason: 'test reason',
            user: { name: 'Joe' }
          })
          return post.save()
        })
        .then((post: any) =>
          post.patches.find({ ref: post.id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([{ op: 'replace', path: '/title', value: 'bar' }])
          )
          assert.equal(patches[1].reason, 'test reason')
          assert.equal(patches[1].user.name, 'Joe')
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done: any) => {
      Post.create({ title: 'baz' })
        .then((post: any) => post.save())
        .then((post: any) => post.patches.find({ ref: post.id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('with changes covered by exclude: does not add a patch', (done: any) => {
      Exclude.findOne({ name: 'exclude1' })
        .then((exclude: any) => {
          exclude.object.hiddenProperty = 'test'
          exclude.array[0].hiddenProperty = 'test'
          return exclude.save()
        })
        .then((exclude: any) => exclude.patches.find({ ref: exclude.id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(() => done())
        .catch(done)
    })
  })

  describe('saving a document with custom _id type', () => {
    it('supports String _id types', (done: any) => {
      Fruit.create({ name: 'apple' })
        .then((fruit: any) => fruit.patches.find({ ref: fruit._id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
          assert.equal(
            JSON.stringify(patches[0].ops),
            JSON.stringify([{ op: 'add', path: '/name', value: 'apple' }])
          )
        })
        .then(() => done())
        .catch(done)
    })
    it('supports Number _id types', (done: any) => {
      Sport.create({ name: 'golf' })
        .then((sport: any) => sport.patches.find({ ref: sport._id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
          assert.equal(
            JSON.stringify(patches[0].ops),
            JSON.stringify([{ op: 'add', path: '/name', value: 'golf' }])
          )
        })
        .then(() => done())
        .catch(done)
    })
  })

  describe('updating a document via findOneAndUpdate()', () => {
    it('upserts a new document', (done: any) => {
      Post.findOneAndUpdate(
        { title: 'doesNotExist' },
        { title: 'findOneAndUpdate' },
        {
          upsert: true,
          new: true
        }
      )
        .then(() => Post.findOne({ title: 'findOneAndUpdate' }))
        .then((post: any) =>
          post.patches.find({ ref: post._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
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

    it('with changes: adds a patch', (done: any) => {
      Post.create({ title: 'findOneAndUpdate1' })
        .then((post: any) =>
          Post.findOneAndUpdate(
            { _id: post._id },
            { title: 'findOneAndUpdate2', __v: 1 },
            { __reason: 'test reason', __user: { name: 'Joe' } }
          )
        )
        .then((post: any) =>
          post.patches.find({ ref: post._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([
              { op: 'replace', path: '/title', value: 'findOneAndUpdate2' }
            ])
          )
          assert.equal(patches[1].reason, 'test reason')
          assert.equal(patches[1].user.name, 'Joe')
        })
        .then(done)
        .catch(done)
    })

    it('without changes: does not add a patch', (done: any) => {
      Post.findOneAndUpdate({ title: 'baz' }, {})
        .then((post: any) => post.patches.find({ ref: post.id }))
        .then((patches: any) => assert.equal(patches.length, 1))
        .then(done)
        .catch(done)
    })

    it('should not throw "TypeError: Cannot set property _original of null" error if doc does not exist', async (): Promise<any> => {
      await Post.findOneAndUpdate(
        { title: 'the_answer_to_life' },
        { title: '42', comments: 'thanks for all the fish' }
      )
        .then((post: any) => assert.strictEqual(post, null))
        .catch((e: any) => assert.fail(e.message))
    })

    it('with options: { new: true }', async (): Promise<any> => {
      const title: any = 'findOneAndUpdateNewTrue'
      await Post.create({ title })
      await Post.findOneAndUpdate({ title }, { title: 'baz' }, { new: true })
        .then((post: any) => post.patches.find({ ref: post._id }))
        .then((patches: any) => assert.strictEqual(patches.length, 2))
        .catch((e: any) => assert.fail(e.message))
    })

    it('with options: { rawResult: true }', async (): Promise<any> => {
      const title: any = 'findOneAndUpdateRawResultTrue'
      await Post.create({ title })
      await Post.findOneAndUpdate(
        { title },
        { title: 'baz' },
        { rawResult: true }
      )
        .then((post: any) =>
          post.value.patches.find({
            ref: post.value._id
          })
        )
        .then((patches: any) => assert.strictEqual(patches.length, 2))
        .catch((e: any) => assert.fail(e.message))
    })
  })

  describe('updating a document via updateOne()', () => {
    it('with changes: adds a patch', (done: any) => {
      Post.create({ title: 'updateOne1' })
        .then((post: any) =>
          Post.updateOne({ _id: post._id }, { title: 'updateOne2' })
        )
        .then(() => Post.findOne({ title: 'updateOne2' }))
        .then((post: any) =>
          post.patches.find({ ref: post._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
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

    it('without changes: does not add a patch', (done: any) => {
      Post.updateOne({ title: 'baz' }, {})
        .then(() => Post.findOne({ title: 'baz' }))
        .then((post: any) => post.patches.find({ ref: post.id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('handles array filters', (done: any) => {
      PricePool.create({
        name: 'test',
        prices: [
          { name: 'test1', value: 1 },
          { name: 'test2', value: 2 }
        ]
      })
        .then((pricePool: any) =>
          PricePool.updateMany(
            { name: pricePool.name },
            { $set: { 'prices.$[elem].value': 3 } },
            { arrayFilters: [{ 'elem.name': { $eq: 'test1' } }] }
          )
        )
        .then(() => PricePool.Patches.find({}))
        .then((patches: any) => {
          assert.equal(patches.length, 2)
        })
        .then(done)
        .catch(done)
    })
  })

  describe('updating a document via updateMany()', () => {
    it('with changes: adds a patch', (done: any) => {
      Post.create({ title: 'updateMany1' })
        .then((post: any) =>
          Post.updateMany({ _id: post._id }, { title: 'updateMany2' })
        )
        .then(() => Post.find({ title: 'updateMany2' }))
        .then((posts: any) =>
          posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
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

    it('without changes: does not add a patch', (done: any) => {
      Post.updateMany({ title: 'baz' }, {})
        .then(() => Post.find({ title: 'baz' }))
        .then((posts: any) => posts[0].patches.find({ ref: posts[0].id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('handles the $push operator', (done: any) => {
      Post.create({ title: 'tagged1', tags: ['match'] })
        .then((post: any) =>
          Post.updateMany(
            { _id: post._id },
            { $push: { tags: 'match2' } },
            { timestamps: false }
          )
        )
        .then(() => Post.find({ title: 'tagged1' }))
        .then((posts: any) =>
          posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
          assert.equal(patches.length, 2)
          assert.equal(
            JSON.stringify(patches[1].ops),
            JSON.stringify([{ op: 'add', path: '/tags/1', value: 'match2' }])
          )
        })
        .then(() => done())
        .catch(done)
    })

    it('handles the $pull operator', (done: any) => {
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
        .then((posts: any) =>
          posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
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
    it('with changes: adds a patch', (done: any) => {
      Post.updateMany(
        { title: 'upsert0' },
        { title: 'upsert1' },
        { upsert: true, multi: true }
      )
        .then(() => Post.find({ title: 'upsert1' }))
        .then((posts: any) =>
          posts[0].patches.find({ ref: posts[0]._id }).sort({ _id: 1 })
        )
        .then((patches: any) => {
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

    it('without changes: does not add a patch', (done: any) => {
      Post.updateMany(
        { title: 'upsert1' },
        { title: 'upsert1' },
        { upsert: true, multi: true }
      )
        .then(() => Post.find({ title: 'upsert1' }))
        .then((posts: any) => posts[0].patches.find({ ref: posts[0].id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })

    it('with updateMany: adds a patch', (done: any) => {
      Post.updateMany(
        { title: 'upsert2' },
        { title: 'upsert3' },
        { upsert: true }
      )
        .then(() => Post.find({ title: 'upsert3' }))
        .then((posts: any) => posts[0].patches.find({ ref: posts[0].id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })
  })

  describe('update with multi', () => {
    it('should not throw "TypeError: Cannot set property _original of null" error if doc does not exist', (done: any) => {
      Post.updateMany(
        { title: { $in: ['foo_bar'] } },
        { title: 'bar_foo' },
        { multi: true, upsert: false }
      )
        .then(() => done())
        .catch(done)
    })
  })

  describe('removing a document', () => {
    it('removes all patches', (done: any) => {
      Post.findOne({ title: 'bar' })
        .then((post: any) => post.remove())
        .then((post: any) => post.patches.find({ ref: post.id }))
        .then((patches: any) => {
          assert.equal(patches.length, 0)
        })
        .then(done)
        .catch(done)
    })
    it("doesn't remove patches when `removePatches` is false", (done: any) => {
      Comment.findOne({ text: 'wat' })
        .then((comment: any) => comment.remove())
        .then((comment: any) => comment.patches.find({ ref: comment.id }))
        .then((patches: any) => {
          assert.equal(patches.length, 1)
        })
        .then(done)
        .catch(done)
    })
    it('removes all patches via findOneAndRemove()', (done: any) => {
      Post.create({ title: 'findOneAndRemove1' })
        .then((post: any) => Post.findOneAndRemove({ _id: post.id }))
        .then((post: any) => post.patches.find({ ref: post.id }))
        .then((patches: any) => {
          assert.equal(patches.length, 0)
        })
        .then(done)
        .catch(done)
    })
  })
  describe('rollback', () => {
    it('with unknown id is rejected', (done: any) => {
      Post.create({ title: 'version 1' }).then((post: any) => {
        return post
          .rollback(new ObjectId())
          .then(() => {
            done()
          })
          .catch((err: any) => {
            assert(err instanceof RollbackError)
            done()
          })
      })
    })

    it('to latest patch is rejected', (done: any) => {
      Post.create({ title: 'version 1' })
        .then((post: any) =>
          Promise.all([post, post.patches.findOne({ ref: post.id })])
        )
        .then(([post, latestPatch]: [any, any]) => {
          return post
            .rollback(latestPatch.id)
            .then(() => {
              done()
            })
            .catch((err: any) => {
              assert(err instanceof RollbackError)
              done()
            })
        })
    })

    it('adds a new patch and updates the document', (done: any) => {
      Comment.create({ text: 'comm 1', user: new ObjectId() })
        .then((c: any) => Comment.findOne({ _id: c.id }))
        .then((c: any) =>
          c.set({ text: 'comm 2', user: new ObjectId() }).save()
        )
        .then((c: any) => Comment.findOne({ _id: c.id }))
        .then((c: any) =>
          c.set({ text: 'comm 3', user: new ObjectId() }).save()
        )
        .then((c: any) => Comment.findOne({ _id: c.id }))
        .then((c: any) => Promise.all([c, c.patches.find({ ref: c.id })]))
        .then(([c, patches]: [any, any]) =>
          c.rollback(patches[1].id, { user: new ObjectId() })
        )
        .then((c: any) => {
          assert.equal(c.text, 'comm 2')
          return c.patches.find({ ref: c.id })
        })
        .then((patches: any) => assert.equal(patches.length, 4))
        .then(done)
        .catch(done)
    })

    it("updates but doesn't save the document", (done: any) => {
      Comment.create({ text: 'comm 1', user: new ObjectId() })
        .then((c: any) => Comment.findOne({ _id: c.id }))
        .then((c: any) =>
          c.set({ text: 'comm 2', user: new ObjectId() }).save()
        )
        .then((c: any) => Comment.findOne({ _id: c.id }))
        .then((c: any) =>
          c.set({ text: 'comm 3', user: new ObjectId() }).save()
        )
        .then((c: any) => Comment.findOne({ _id: c.id }))
        .then((c: any) => Promise.all([c, c.patches.find({ ref: c.id })]))
        .then(([c, patches]: [any, any]) =>
          c.rollback(patches[1].id, { user: new ObjectId() }, false)
        )
        .then((c: any) => {
          assert.equal(c.text, 'comm 2')
          return Comment.findOne({ _id: c.id })
        })
        .then((c: any) => {
          assert.equal(c.text, 'comm 3')
          return c.patches.find({ ref: c.id })
        })
        .then((patches: any) => assert.equal(patches.length, 3))
        .then(done)
        .catch(done)
    })
  })

  describe('model and collection names', () => {
    const getCollectionNames = (): Promise<any> => {
      return new Promise((resolve: any, reject: any) => {
        mongoose.connection.db
          .listCollections()
          .toArray((err: any, collections: any) => {
            if (err) {
              return reject(err)
            }
            resolve(map(collections, 'name'))
          })
      })
    }

    it('pascalize for model and decamelize for collection', (done: any) => {
      Promise.all([
        () => assert(!!~mongoose.modelNames().indexOf('CommentPatches')),
        getCollectionNames().then((names: any) => {
          assert(!!~names.indexOf('comment_patches'))
        })
      ])
        .then(() => done())
        .catch(done)
    })

    it('uses `transform` option when set', (done: any) => {
      Promise.all([
        () => assert(!!~mongoose.modelNames().indexOf('postPatches')),
        getCollectionNames().then((names: any) => {
          assert(!!~names.indexOf('post_history'))
        })
      ])
        .then(() => done())
        .catch(done)
    })
  })

  describe('timestamps', () => {
    it('creates doc and sets mongoose timestamp fields', (done: any) => {
      Post.create({ title: 'ts1' })
        .then((post: any) =>
          post.patches
            .find({ ref: post._id })
            .sort({ _id: 1 })
            .then((patches: any) => {
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

    it('updates doc and sets mongoose timestamp fields', (done: any) => {
      Post.create({ title: 'ts2' })
        .then(({ _id }: { _id: any }) =>
          Post.updateOne({ _id }, { $set: { title: 'ts2.1' } })
        )
        .then(() => Post.findOne({ title: 'ts2.1' }))
        .then((post: any) =>
          post.patches
            .find({ ref: post._id })
            .sort({ _id: 1 })
            .then((patches: any) => {
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
        )
        .then(done)
        .catch(done)
    })
  })

  describe('jsonpatch.compare', () => {
    let Organization: any
    let Person: any

    before(() => {
      Organization = mongoose.model(
        'Organization',
        new mongoose.Schema({
          name: String
        })
      )

      const PersonSchema: any = new mongoose.Schema({
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
      Person = mongoose.model('Person', PersonSchema)
    })

    it('is able to handle ObjectId references correctly', (done: any) => {
      Organization.create({ text: 'Home' })
        .then((o1: any) =>
          Promise.all([o1, Organization.create({ text: 'Work' })])
        )
        .then(([o1, o2]: [any, any]) =>
          Promise.all([
            o1,
            o2,
            Person.create({ name: 'Bob', organization: o1._id })
          ])
        )
        .then(([o1, o2, p]: [any, any, any]) =>
          Promise.all([o1, o2, p.set({ organization: o2._id }).save()])
        )
        .then(([o1, o2, p]: [any, any, any]) =>
          Promise.all([o1, o2, p.patches.find({ ref: p.id })])
        )
        .then(([o1, o2, patches]: [any, any, any]) => {
          const pathFilter = (path: any) => (elem: any) => elem.path === path
          const firstOrganizationOperation = patches[0].ops.find(
            pathFilter('/organization')
          )
          const secondOrganizationOperation = patches[1].ops.find(
            pathFilter('/organization')
          )
          assert.deepStrictEqual(
            firstOrganizationOperation.value.toString(),
            o1._id.toString()
          )
          assert.deepStrictEqual(
            secondOrganizationOperation.value.toString(),
            o2._id.toString()
          )
        })
        .then(done)
        .catch(done)
    })
  })

  describe('track original values', () => {
    let Company: any

    before(() => {
      const CompanySchema: any = new mongoose.Schema({
        name: String
      })

      CompanySchema.plugin(patchHistory, {
        mongoose: mongoose,
        name: 'companyPatches',
        trackOriginalValue: true
      })
      Company = mongoose.model('Company', CompanySchema)
    })

    after((done: any) => {
      Promise.all([Company.remove(), Company.Patches.remove()]).then(() =>
        done()
      )
    })

    it('stores the original value in the ops entries', (done: any) => {
      Company.create({ name: 'Private' })
        .then((c: any) => c.set({ name: 'Private 2' }).save())
        .then((c: any) => c.set({ name: 'Private 3' }).save())
        .then((c: any) => c.patches.find().sort({ _id: 1 }))
        .then((patches: any) => {
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
        .catch(done)
    })
  })
})
