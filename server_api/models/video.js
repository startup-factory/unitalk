"use strict";

const async = require("async");
const log = require('../utils/logger');
const aws = require('aws-sdk');
const _ = require('lodash');
const queue = require('../active-citizen/workers/queue');

module.exports = (sequelize, DataTypes) => {
  const Video = sequelize.define("Video", {
    name: DataTypes.STRING,
    description: DataTypes.TEXT,
    meta: DataTypes.JSONB,
    public_meta: DataTypes.JSONB,
    formats: DataTypes.JSONB,
    views:{ type: DataTypes.BIGINT, defaultValue: 0 },
    long_views:{ type: DataTypes.BIGINT, defaultValue: 0 },
    user_id: DataTypes.INTEGER,
    viewable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ip_address: { type: DataTypes.STRING, allowNull: false },
    user_agent: { type: DataTypes.TEXT, allowNull: false },
    deleted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
  }, {

    underscored: true,

    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',

    tableName: 'videos',

    defaultScope: {
      where: {
        deleted: false
      },
      order: [
        ['created_at', 'asc' ]
      ]
    },

    indexes: [
      {
        fields: ['meta'],
        using: 'gin',
        operator: 'jsonb_path_ops'
      },
      {
        name: 'videos_idx_deleted',
        fields: ['deleted']
      },
      {
        fields: ['public_meta'],
        using: 'gin',
        operator: 'jsonb_path_ops'
      },
      {
        fields: ['formats'],
        using: 'gin',
        operator: 'jsonb_path_ops'
      },
      {
        fields: ['user_id', 'viewable', 'deleted']
      },
      {
        fields: ['id', 'deleted']
      }
    ],

    // Add following index manually for high throughput sites
    // CREATE INDEX videoimage_idx_video_id ON "VideoImage" (video_id);
  });

  Video.associate = (models) => {
    Video.belongsTo(models.User, { foreignKey: 'user_id'});
    Video.belongsToMany(models.Post, { as: 'PostVideos', through: 'PostVideo' });
    Video.belongsToMany(models.Image, { as: 'VideoImages', through: 'VideoImage' });
    Video.belongsToMany(models.Point, { as: 'PointVideos', through: 'PointVideo' });
    Video.belongsToMany(models.User, { as: 'UserProfileVideos', through: 'UserProfileVideo' });
    Video.belongsToMany(models.Community, { as: 'CommunityLogoVideos', through: 'CommunityLogoVideo' });
    Video.belongsToMany(models.Group, { as: 'GroupLogoVideos', through: 'GroupLogoVideo' });
    Video.belongsToMany(models.Domain, { as: 'DomainLogoVideos', through: 'DomainLogoVideo' });
  };

  Video.defaultAttributesPublic = ["id","updated_at","formats"];

  Video.getRandomFileKey = (id) => {
    const random =  Math.random().toString(36).substring(2, 9);
    return random+'_video' + id +'.mp4';
  };

  Video.getFullUrl = (meta) => {
    if (meta) {
      return 'https://'+meta.publicBucket+'.'+meta.endPoint+'/'+meta.fileKey;
    }
  };

  Video.getThumbnailUrl = (video, number) => {
    const zerofilled = ('00000'+number).slice(-5);
    const fileKey = video.meta.fileKey+'_thumbs-' + video.id + '-'+zerofilled+'.png';
    return 'https://'+video.meta.thumbnailBucket+'.'+video.meta.endPoint+'/'+fileKey;
  };

  Video.createAndGetSignedUploadUrl = (req, res) => {
    const userId = req.user.id;
    sequelize.models.Video.build({
      user_id: userId,
      user_agent: req.useragent.source,
      ip_address: req.clientIp,
    }).save().then((video) => {
      video.getPreSignedUploadUrl({}, (error, presignedUrl) => {
        if (error) {
          log.error("Could not get preSigned URL for video", { error });
          res.sendStatus(500);
        } else {
          log.info("Got presigned url", { presignedUrl })
          res.send({ presignedUrl, videoId: video.id });
        }
      });
    }).catch((error) => {
      log.error("Could not create video", { error });
      res.sendStatus(500);
    })
  };

  Video.addToPost = (video, options, callback) => {
    sequelize.models.Post.findOne({
      where: {
        id: options.postId
      }
    }).then((post) => {
      post.addPostVideo(video).then(() => {
        log.info("Have added video to post", { id: options.postId });
        if (process.env.GOOGLE_TRANSCODING_FLAC_BUCKET && process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
          if (!post.public_data) {
            post.set('public_data', {});
          }
          post.set('public_data.transcript', {});
          post.set('public_data.transcript', { videoId: video.id });
          post.set('public_data.transcript.inProgress', true);
          post.set('public_data.transcript.inProgressDate', new Date());
          const workPackage = {
            browserLanguage: options.browserLanguage,
            appLanguage:options.appLanguage,
            videoId: video.id,
            type: 'create-video-transcript' };
          queue.create('process-voice-to-text', workPackage).priority('high').removeOnComplete(true).save();
          post.save().then( () => {
            callback();
          }).catch( error => {
            callback(error);
          })
        } else {
          callback();
        }
      });
    }).catch((error) => callback(error));
  };

  Video.addToDomain = (video, id, callback) => {
    sequelize.models.Domain.findOne({
      where: {
        id: id
      }
    }).then((domain) => {
      domain.addDomainLogoVideo(video).then(() => {
        log.info("Have added video to domain", { id });
        callback();
      });
    }).catch((error) => callback(error));
  };

  Video.addToCommunity = (video, id, callback) => {
    sequelize.models.Community.findOne({
      where: {
        id: id
      }
    }).then((community) => {
      community.addCommunityLogoVideo(video).then(() => {
        log.info("Have added video to community", { id });
        callback();
      });
    }).catch((error) => callback(error));
  };

  Video.addToGroup = (video, id, callback) => {
    sequelize.models.Group.findOne({
      where: {
        id: id
      }
    }).then((group) => {
      group.addGroupLogoVideo(video).then(() => {
        log.info("Have added video to group", { id });
        callback();
      });
    }).catch((error) => callback(error));
  };

  Video.addToCollection = (video, options, callback) => {
    if (options.postId) {
      sequelize.models.Video.addToPost(video, options, callback);
    } else if (options.groupId) {
      sequelize.models.Video.addToGroup(video, options.groupId, callback);
    } else if (options.communityId) {
      sequelize.models.Video.addToCommunity(video, options.communityId, callback);
    } else if (options.domainId) {
      sequelize.models.Video.addToDomain(video, options.domainId, callback);
    } else {
      callback("No collection to add to");
    }
  };

  Video.setupThumbnailsAfterTranscoding = (video, duration, req, callback) => {
    const interval = 10;
    let frames = [];
    const numberOfFrames = Math.max(1, Math.floor(duration/interval));

    for (let frame = 0; frame < numberOfFrames; frame++) {
      frames.push(sequelize.models.Video.getThumbnailUrl(video,frame+1));
    }

    async.forEachSeries(frames, (frame, foreachCallback) => {
      sequelize.models.Image.build({
        s3_bucket_name: video.meta.thumbnailBucket,
        user_id: req.user.id,
        user_agent: "AWS Transcoder",
        ip_address: "127.0.0.1",
        formats: JSON.stringify([frame])
      }).save().then((image) => {
        // We add a small delay to make sure the images can be ordered by updated_at
        setTimeout(() => {
          video.addVideoImage(image).then(() => {
            foreachCallback();
          }).catch((error) => {
            foreachCallback(error);
          })
        }, 1)
      }).catch((error) => {
        foreachCallback(error);
      })
    }, (error) => {
      callback(error)
    });
  };

  Video.getTranscodingJobStatus = (video, req, res ) => {
    const params = {
      Id: req.body.jobId
    };
    const eltr = new aws.ElasticTranscoder({
      apiVersion: '2012–09–25',
      region: process.env.S3_REGION ? process.env.S3_REGION : 'eu-west-1'
    });
    eltr.readJob(params, (error, data) => {
      if (error) {
        log.error("Could not get status of transcoding job", { error });
        res.sendStatus(500);
      } else {
        const jobStatus = { status: data.Job.Status, statusDetail: data.Job.StatusDetail };
        if (jobStatus.status==="Complete") {
          const duration = data.Job.Output.Duration;
          sequelize.models.Video.setupThumbnailsAfterTranscoding(video, duration, req, (error) => {
            if (error) {
              log.error("Could not connect image and video", { error });
              res.sendStatus(500);
            } else {
              res.send(jobStatus);
            }
          })
        } else if (jobStatus.status==="Error") {
          if (data.Job.Outputs && data.Job.Outputs.length>1 &&
            data.Job.Outputs[0].Status==='Complete' && data.Job.Outputs[1].Status==='Error') {
            log.info("Transcoding no audio channel found", { data });
            const duration = data.Job.Output.Duration;
            sequelize.models.Video.setupThumbnailsAfterTranscoding(video, duration, req, (error) => {
              if (error) {
                log.error("Could not connect image and video", { error });
                res.sendStatus(500);
              } else {
                res.send({ status: "Complete" });
              }
            })
          } else {
            log.error("Could not transcode video image and video", { jobStatus: jobStatus, data: data, dataJob: data.Job });
            res.sendStatus(500);
          }
        } else {
          res.send(jobStatus);
        }
      }
    });
  };

  Video.startTranscoding = (video, options, req, res) => {
    if (options.videoPostUploadLimitSec && options.videoPostUploadLimitSec!=="") {
      const postLimitSeconds = parseInt(options.videoPostUploadLimitSec);
      video.set('meta.maxDuration', Math.min(postLimitSeconds, 600));
    } else if (options.videoPointUploadLimitSec && options.videoPointUploadLimitSec!=="") {
      const pointLimitSeconds = parseInt(options.videoPointUploadLimitSec);
      video.set('meta.maxDuration', Math.min(pointLimitSeconds, 600));
    } else {
      video.set('meta.maxDuration', "600");
    }

    if (!video.public_meta) {
      video.set('public_meta', {});
    }

    if (options.aspect==="portrait") {
      video.set('meta.aspect',"portrait");
      video.set('public_meta.aspect',"portrait");
    } else if (options.aspect==="landscape") {
      video.set('meta.aspect',"landscape");
      video.set('public_meta.aspect',"landscape");
    }

    video.save().then((video) => {
      sequelize.models.Video.startTranscodingJob(video, (error, data) => {
        if (error) {
          log.error("Could not start transcoding job", { error });
          res.sendStatus(500);
        } else {
          res.send({ transcodingJobId: data.Job.Id });
        }
      });
    }).catch((error) => {
      log.error("Could not start transcoding job", { error });
      res.sendStatus(500);
    });
  };

  Video.completeUploadAndAddToPoint = (req, res, options, callback) => {
    sequelize.models.Video.findOne({
      where: {
        id: options.videoId
      },
      attributes: sequelize.models.Video.defaultAttributesPublic.concat(['user_id','meta'])
    }).then((video) => {
      if (video.user_id===req.user.id) {
        video.viewable = true;
        video.createFormats(video);
        video.save().then(() => {
          sequelize.models.Point.findOne({
            where: {
              id: options.pointId
            }
          }).then((point) => {
            point.addPointVideo(video).then(() => {
              log.info("Have added video to point", { id: options.pointId });
              callback();
            });
          }).catch((error) => callback(error));
        }).catch((error) => {
          callback(error);
        });
      } else {
        callback("Could not get video for wrong user");
      }
    }).catch((error) => {
      callback(error);
    });
  };

  Video.completeUploadAndAddToCollection = (req, res, options) => {
    sequelize.models.Video.findOne({
      where: {
        id: options.videoId
      },
      attributes: sequelize.models.Video.defaultAttributesPublic.concat(['user_id','meta'])
    }).then((video) => {
      if (video.user_id===req.user.id) {
        video.viewable = true;
        video.createFormats(video);
        video.save().then(() => {
          sequelize.models.Video.addToCollection(video, options, (error) => {
            if (error) {
              log.error("Could not add video to collection", { error, options});
              res.sendStatus(500);
            } else {
              res.sendStatus(200);
            }
          });
        }).catch((error) => {
          log.error("Could not save video", { error });
          res.sendStatus(500);
        });
      } else {
        log.error("Could not get video for wrong user");
        res.sendStatus(401);
      }
    }).catch((error) => {
      log.error("Could not get video", { error });
      res.sendStatus(500);
    });
  };

  Video.startTranscodingJob = (video, callback) => {
    const eltr = new aws.ElasticTranscoder({
      apiVersion: '2012–09–25',
      region: process.env.S3_REGION ? process.env.S3_REGION : 'eu-west-1'
    });
    const fileKey = video.meta.fileKey;
    const pipelineId = process.env.AWS_TRANSCODER_PIPELINE_ID;
    let videoPresetId;

    if (video.meta.aspect && video.meta.aspect==="portrait") {
      videoPresetId = process.env.AWS_TRANSCODER_PORTRAIT_PRESET_ID;
    } else {
      videoPresetId = process.env.AWS_TRANSCODER_PRESET_ID;
    }

    const params = {
      PipelineId: pipelineId,
      Input: {
        Key: fileKey,
        FrameRate: 'auto',
        Resolution: 'auto',
        AspectRatio: 'auto',
        Interlaced: 'auto',
        Container: 'auto',
        TimeSpan: {
          Duration: video.meta.maxDuration+'.000'
        }
      },
      Outputs: [
        {
          Key: fileKey,
          ThumbnailPattern: fileKey+'_thumbs-' + video.id + '-{count}',
          Rotate : "auto",
          PresetId: videoPresetId,
        },
        {
          Key: fileKey.slice(0, fileKey.length-4)+'.flac',
          PresetId: process.env.AWS_TRANSCODER_FLAC_PRESET_ID
        }
      ]
    };
    log.info('Starting AWS transcoding Job');
    eltr.createJob(params,  (error, data) => {
      if (error) {
        log.error("Error creating AWS transcoding job", { error });
        callback(error);
      } else {
        callback(null, data)
      }
    });
  };

  Video.prototype.createFormats = function (video) {
    this.formats = [];
    this.formats.push(sequelize.models.Video.getFullUrl(video.meta));
  };

  Video.prototype.getPreSignedUploadUrl = function (options, callback) {
    const endPoint = process.env.S3_ENDPOINT || "s3.amazonaws.com";
    const accelEndPoint = process.env.S3_ACCELERATED_ENDPOINT || process.env.S3_ENDPOINT || "s3.amazonaws.com";
    const s3 = new aws.S3({
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      endpoint: accelEndPoint,
      useAccelerateEndpoint: process.env.S3_ACCELERATED_ENDPOINT!=null,
      region: process.env.S3_REGION || ((process.env.S3_ENDPOINT || process.env.S3_ACCELERATED_ENDPOINT) ? null : 'us-east-1'),
    });

    const signedUrlExpireSeconds = 60 * 60;
    const bucketName = process.env.S3_VIDEO_UPLOAD_BUCKET;
    const publicBucket = process.env.S3_VIDEO_PUBLIC_BUCKET;
    const thumbnailBucket = process.env.S3_VIDEO_THUMBNAIL_BUCKET;

    const contentType = 'video/mp4';
    const a = this.id;
    const fileKey = sequelize.models.Video.getRandomFileKey(this.id);

    const s3Params = {
      Bucket: bucketName,
      Key: fileKey,
      Expires: signedUrlExpireSeconds,
      ACL: 'bucket-owner-full-control',
      ContentType: contentType
    };
    s3.getSignedUrl('putObject', s3Params, (error, url) => {
      if (error) {
        log.error('Error getting presigned url from AWS S3', { error });
        callback(error);
      }
      else {
        let meta = { bucketName, publicBucket, endPoint, accelEndPoint, thumbnailBucket,
          maxDuration: options.maxDuration, fileKey, contentType, uploadUrl: url };
        if (this.meta)
          meta = _.merge(this.meta, meta);
        this.set('meta', meta);
        log.info('Presigned URL:', { url, meta });
        log.info('Saving video metadata');
        this.save().then(() => {
          callback(null, url);
        }).catch((error) => { callback(error) });
      }
    });
  };

  return Video;
};
