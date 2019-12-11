"use strict";

const async = require("async");

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define("Category", {
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    icon_file_name: DataTypes.STRING,
    language: { type: DataTypes.STRING, allowNull: true }
  }, {
    underscored: true,
    
    tableName: 'categories',

    defaultScope: {
      where: {
        deleted: false
      }
    },

    indexes: [
      {
        fields: ['id', 'deleted']
      },
      {
        name: 'categories_idx_deleted_group_id',
        fields: ['deleted','group_id']
      },
      {
        name: 'categories_idx_deleted',
        fields: ['deleted']
      }
    ],

    // Add following indexes manually for high throughput sites
    // CREATE INDEX categoryiconimage_idx_category_id ON "CategoryIconImage" (category_id);
    // CREATE INDEX communityheaderimage_idx_community_id ON "CommunityHeaderImage" (community_id);

    timestamps: true,
  });

  Category.associate = (models) => {
    Category.hasMany(models.Post);
    Category.belongsTo(models.Group);
    Category.belongsToMany(models.Image, {
      as: 'CategoryIconImages',
      through: 'CategoryIconImage'});
    Category.belongsToMany(models.Image, { as: 'CategoryHeaderImages', through: 'CategoryHeaderImage' });
  };

  Category.prototype.setupIconImage = (body, done) => {
    if (body.uploadedIconImageId) {
      sequelize.models.Image.find({
        where: {id: body.uploadedIconImageId}
      }).then((image) => {
        if (image)
          this.addCategoryIconImage(image);
        done();
      });
    } else done();
  };

  Category.prototype.setupHeaderImage = (body, done) => {
    if (body.uploadedHeaderImageId) {
      sequelize.models.Image.find({
        where: {id: body.uploadedHeaderImageId}
      }).then((image) => {
        if (image)
          this.addCategoryHeaderImage(image);
        done();
      });
    } else done();
  };

  Category.prototype.setupImages = (body, done) => {
    async.parallel([
      (callback) => {
        this.setupIconImage(body,  (err) => {
          if (err) return callback(err);
          callback();
        });
      },
      (callback) => {
        this.setupHeaderImage(body,  (err) => {
          if (err) return callback(err);
          callback();
        });
      }
    ], (err) => {
      done(err);
    });
  };

  return Category;
};
