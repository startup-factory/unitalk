#!/usr/bin/env node
require('newrelic');

FORCE_PRODUCTION = false;

const log = require('./utils/logger');

if (!process.env.S3_BUCKET) {
  process.env.S3_BUCKET="no-bucket-implemented-please-set-S3_BUCKET";
  const errorText = "No S3_BUCKET is set, image uploads and report downloads will not work";
  log.error(errorText);
  console.error(errorText);
}

const express = require('express');
const session = require('express-session');
const path = require('path');
const logger = require('morgan');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const RedisStore = require('connect-redis')(session);
const useragent = require('express-useragent');
const requestIp = require('request-ip');
const compression = require('compression');
const isBot = require("isbot");
const redis = require('redis');

const passport = require('passport')
  , LocalStrategy = require('passport-local').Strategy
  , FacebookStrategy = require('passport-facebook').Strategy
  , GitHubStrategy = require('passport-github').Strategy
  , TwitterStrategy = require('passport-twitter').Strategy
  , GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;

const models = require('./models');
const auth = require('./authorization');

const index = require('./controllers/index');
const news_feeds = require('./active-citizen/controllers/news_feeds');
const activities = require('./active-citizen/controllers/activities');
const notifications = require('./active-citizen/controllers/notifications');
const recommendations = require('./active-citizen/controllers/recommendations');

const posts = require('./controllers/posts');
const groups = require('./controllers/groups');
const communities = require('./controllers/communities');
const domains = require('./controllers/domains');
const organizations = require('./controllers/organizations');
const points = require('./controllers/points');
const users = require('./controllers/users');
const categories = require('./controllers/categories');
const images = require('./controllers/images');
const ratings = require('./controllers/ratings');
const bulkStatusUpdates = require('./controllers/bulkStatusUpdates');
const videos = require('./controllers/videos');
const audios = require('./controllers/audios');

const legacyPosts = require('./controllers/legacyPosts');
const legacyUsers = require('./controllers/legacyUsers');
const legacyPages = require('./controllers/legacyPages');

const nonSPArouter = require('./controllers/nonSpa');

const generateSitemap = require('./utils/sitemap_generator');
const generateManifest = require('./utils/manifest_generator');

const toJson = require('./utils/to_json');
const sso = require('passport-sso');
const cors = require('cors');

const Airbrake = require('@airbrake/node');
const airbrakeExpress = require('@airbrake/node/dist/instrumentation/express');
const airbrakePG = require('@airbrake/node/dist/instrumentation/pg');

if (process.env.REDISTOGO_URL) {
  process.env.REDIS_URL = process.env.REDISTOGO_URL;
}

let airbrake = null;

if (process.env.AIRBRAKE_PROJECT_ID) {
  airbrake = new Airbrake.Notifier({
    projectId: process.env.AIRBRAKE_PROJECT_ID,
    projectKey: process.env.AIRBRAKE_API_KEY,
    performanceStats: false
  });
}

const app = express();

if (process.env.AIRBRAKE_PROJECT_ID) {
  app.use(airbrakeExpress.makeMiddleware(airbrake));
}

if (app.get('env') !== 'development' && !process.env.DISABLE_FORCE_HTTPS) {
  app.use( function checkProtocol (req, res, next) {
    if (!/https/.test(req.protocol)) {
      res.redirect("https://" + req.headers.host + req.url);
    } else {
      return next();
    }
  });
}

app.set('port', process.env.PORT || 4242);
app.use(compression());
app.set('views', __dirname + '/views');
app.set('view engine', 'jade');

app.use(cors());

app.use(morgan('combined'));
app.use(useragent.express());
app.use(requestIp.mw());
app.use(bodyParser.json({limit: '5mb'}));
app.use(bodyParser.urlencoded({limit: '5mb', extended: true}));

var sessionConfig = {
  store: new RedisStore({url: process.env.REDIS_URL}),
  name: 'yrpri.sid',
  secret: process.env.SESSION_SECRET ? process.env.SESSION_SECRET : 'not so secret... use env var.',
  resave: false,
  cookie: {autoSubDomain: true},
  saveUninitialized: true
};

if (app.get('env') === 'production') {
  app.set('trust proxy', 1); // trust first proxy
  sessionConfig.cookie.secure = true; // serve secure cookies
}

app.get('/*', function (req, res, next) {
  if (req.url.indexOf("service-worker.js") > -1) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Last-Modified", new Date(Date.now()).toUTCString());
  }
  next();
});

if (!FORCE_PRODUCTION && app.get('env') === 'development') {
  app.use(express.static(path.join(__dirname, '../client_app'), { index: false }));
} else {
  app.use(express.static(path.join(__dirname, '../client_app/build/bundled'), { index: false, dotfiles:'allow' }));
}

app.use(session(sessionConfig));

// Setup the current domain from the host
app.use(function setupDomain(req, res, next) {
  models.Domain.setYpDomain(req, res, function () {
    log.info("Setup Domain Completed", {context: 'setYpDomain',
      domainId: req.ypDomain ? req.ypDomain.id : null,
      domainName: req.ypDomain ? req.ypDomain.domain_name : null
    });
    next();
  });
});

// Setup the current community from the host
app.use(function setupCommunity(req, res, next) {
  models.Community.setYpCommunity(req, res, function () {
    log.info("Setup Community Completed", {context: 'setYpCommunity', community: req.ypCommunity.hostname});
    next();
  });
});

app.use(passport.initialize());
app.use(passport.session());

app.use(function setupRedis(req, res, next) {
  req.redisClient = sessionConfig.store.client;
  next();
});

app.get('/sitemap.xml', function getSitemap(req, res) {
  const redisKey = "cache:sitemapv14:" + req.ypDomain.id + (req.ypCommunity && req.ypCommunity.id && req.ypCommunity.hostname) ? req.ypCommunity.hostname : '';
  req.redisClient.get(redisKey, (error, sitemap) => {
    if (error) {
      log.error("Error getting sitemap from redis", {error});
      generateSitemap(req, res);
    } else if (sitemap) {
      res.header('Content-Type', 'application/xml');
      res.set({ 'content-type': 'application/xml' });
      res.send(sitemap);
    } else {
      generateSitemap(req, res);
    }
  });
});

app.use(function checkForBOT(req, res, next) {
  var ua = req.headers['user-agent'];
  if (!/Googlebot|AdsBot-Google/.test(ua) && (isBot(ua) || /^(facebookexternalhit)|(web\/snippet)|(Twitterbot)|(Slackbot)|(Embedly)|(LinkedInBot)|(Pinterest)|(XING-contenttabreceiver)/gi.test(ua))) {
    log.info('Request is from a bot', { ua });
    nonSPArouter(req, res, next);
  } else {
    next();
  }
});

app.get('/manifest.json', function getManifest(req, res) {
  generateManifest(req, res);
});

var bearerCallback = function (req, token) {
  return console.log('The user has tried to authenticate with a bearer token');
};

app.use(function checkAuthForSsoInit(req, res, next) {
  if (req.url.indexOf('/auth') > -1 || req.url.indexOf('/login') > -1 || req.url.indexOf('saml_assertion') > -1) {
    sso.init(req.ypDomain.loginHosts, req.ypDomain.loginProviders, {
      authorize: bearerCallback,
      login: models.User.localCallback
    });
    req.sso = sso;
  }
  next();
});

const completeRegisterUserLogin = (user, loginType, req, done) => {
  user.last_login_at = Date.now();
  user.save().then(() => {
    models.AcActivity.createActivity({
      type:'activity.user.login',
      userId: user.id,
      domainId: req.ypDomain.id,
      communityId: req.ypCommunity ? req.ypCommunity.id : null,
      object: {
        loginType: loginType,
        userDepartment: user.private_profile_data ? user.private_profile_data.saml_agency : null,
        samlProvider: user.private_profile_data ? user.private_profile_data.saml_provider : null
      },
      access: models.AcActivity.PRIVATE
    }, function (error) {
      if (error)
        log.error("Error in create activity", { error });
      done();
    });
  }).catch( (error) => {
    log.error("Error saving user for login registration", { error });
    done();
  });
};

const registerUserLogin = (user, userId, loginProvider, req, done) => {
  if (user && user.private_profile_data) {
    completeRegisterUserLogin(user, loginProvider, req, done);
  } else {
    models.User.findOne({
      where: {
        id: userId
      },
      attributes: ['id','private_profile_data','last_login_at']
    }).then((user) => {
      if (user) {
        completeRegisterUserLogin(user, loginProvider, req, done);
      } else {
        log.error("Did not find user for login registration", { error });
        done();
      }
    }).catch( (error) => {
      log.error("Error saving user for login registration", { error });
      done();
    });
  }
};

passport.serializeUser(function userSerialize(req, profile, done) {
  log.info("User Serialized", { logionProvider: profile.provider });
  if (profile.provider && profile.provider === 'facebook') {
    models.User.serializeFacebookUser(profile, req.ypDomain, function (error, user) {
      if (error) {
        log.error("Error in User Serialized from Facebook", {err: error});
        done(error);
      } else {
        log.info("User Serialized Connected to Facebook", {context: 'loginFromFacebook', userId: user.id });
        registerUserLogin(user, user.id, 'facebook', req, function () {
          done(null, {userId: user.id, loginProvider: 'facebook'});
        });
      }
    });
  } else if (profile.provider && profile.provider === "saml") {
    models.User.serializeSamlUser(profile, req, function (error, user) {
      if (error) {
        log.error("Error in User Serialized from SAML", {err: error});
        done(error);
      } else {
        log.info("User Serialized Connected to SAML", {context: 'loginFromSaml', userId: user.id});
        registerUserLogin(user, user.id, 'saml', req, function () {
          done(null, {userId: user.id, loginProvider: 'saml'});
        });
      }
    });
  } else {
    log.info("User Serialized", {
      context: 'serializeUser',
      userEmail: profile.email,
      userId: profile.id
    });
    registerUserLogin(null, profile.id, 'email', req, function () {
      done(null, {userId: profile.id, loginProvider: 'email'});
    });
  }
});

passport.deserializeUser(function deserializeUser(sessionUser, done) {
  log.info("Debug passport.deserializeUser", { sessionUser });
  models.User.findOne({
    where: {id: sessionUser.userId},
    attributes: ["id", "name", "email", "default_locale", "facebook_id", "twitter_id", "google_id", "github_id", "ssn", "profile_data", 'private_profile_data'],
    include: [
      {
        model: models.Image, as: 'UserProfileImages',
        required: false
      },
      {
        model: models.Image, as: 'UserHeaderImages',
        required: false
      }
    ]
  }).then(function (user) {
    if (user) {
      log.info("User Deserialized", {context: 'deserializeUser', user: user.email});
      user.loginProvider = sessionUser.loginProvider;
      if (user.private_profile_data && user.private_profile_data.saml_agency && sessionUser.loginProvider==='saml') {
        user.isSamlEmployee = true;
        log.info("SAML isSamlEmployee is true");
      }
      done(null, user);
      return null;
    } else {
      log.error("User Deserialized Not found", {context: 'deserializeUser'});
      if (airbrake) {
        airbrake.notify("User Deserialized Not found").then((airbrakeErr) => {
          if (airbrakeErr.error) {
            log.error("AirBrake Error", {
              context: 'airbrake',
              user: toJson(req.user),
              err: airbrakeErr.error,
              errorStatus: 500
            });
          }
        });
      }
      return done(null, false);
    }
  }).catch(function (error) {
    log.error("User Deserialize Error", {context: 'deserializeUser', user: sessionUser.userId, err: error, errorStatus: 500});
    if (airbrake) {
      airbrake.notify(error).then((airbrakeErr) => {
        if (airbrakeErr.error) {
          log.error("AirBrake Error", {
            context: 'airbrake',
            user: null,
            err: airbrakeErr.error,
            errorStatus: 500
          });
        }
      });
    }
    return done(null, false);
  });
});

app.use('/', index);

// Set caching for IE so it wont cache the json queries
app.use(function cacheControlHeaders(req, res, next) {
  var ua = req.headers['user-agent'];
  if (/Trident/gi.test(ua)) {
    res.set("Cache-Control", "no-cache,no-store");
  }
  next();
});

app.use('/domain', index);
app.use('/community', index);
app.use('/group', index);
app.use('/post', index);
app.use('/user', index);
app.use('/api/domains', domains);
app.use('/api/organizations', organizations);
app.use('/api/communities', communities);
app.use('/api/groups', groups);
app.use('/api/posts', posts);
app.use('/api/points', points);
app.use('/api/images', images);
app.use('/api/videos', videos);
app.use('/api/audios', audios);
app.use('/api/categories', categories);
app.use('/api/users', users);
app.use('/api/news_feeds', news_feeds);
app.use('/api/activities', activities);
app.use('/api/notifications', notifications);
app.use('/api/bulk_status_updates', bulkStatusUpdates);
app.use('/api/recommendations', recommendations);
app.use('/api/ratings', ratings);
app.use('/ideas', legacyPosts);
app.use('/users', legacyUsers);
app.use('/pages', legacyPages);

app.post('/authenticate_from_island_is', function (req, res) {
  log.info("SAML SAML 1", {domainId: req.ypDomain.id});
  req.sso.authenticate('saml-strategy-' + req.ypDomain.id, {}, req, res, function (error, user) {
    log.info("SAML SAML 2", {domainId: req.ypDomain.id, err: error});
    if (error) {
      log.error("Error from SAML login", {err: error});
      error.url = req.url;
      if (airbrake) {
        airbrake.notify(error).then((airbrakeErr) => {
          if (airbrakeErr.error) {
            log.error("AirBrake Error", {context: 'airbrake', err: airbrakeErr.error, errorStatus: 500});
          }
          res.sendStatus(500);
        });
      }
    } else {
      log.info("SAML SAML 3", {domainId: req.ypDomain.id});
      res.render('samlLoginComplete', {});
    }
  })
});

app.post('/saml_assertion', function (req, res) {
  log.info("SAML SAML 1 General", {domainId: req.ypDomain.id});
  req.sso.authenticate('saml-strategy-' + req.ypDomain.id, {}, req, res, function (error, user) {
    log.info("SAML SAML 2 General", {domainId: req.ypDomain.id, err: error});
    if (error) {
      log.error("Error from SAML General login", {err: error});
      if (error==='customError') {
        res.render('samlCustomError', {
          customErrorHTML: req.ypDomain.configuration.customSAMLErrorHTML,
          closeWindowText: "Close window"
        });
      } else {
        error.url = req.url;
        if (airbrake) {
          airbrake.notify(error).then((airbrakeErr) => {
            if (airbrakeErr.error) {
              log.error("AirBrake Error", {context: 'airbrake', err: airbrakeErr.error, errorStatus: 500});
            }
            res.sendStatus(500);
          });
        } else {
          res.sendStatus(500);
        }
      }
    } else {
      log.info("SAML SAML 3 General", {domainId: req.ypDomain.id});
      res.render('samlLoginComplete', {});
    }
  })
});

app.use(function check401errors(err, req, res, next) {
  if (err instanceof auth.UnauthorizedError) {
    log.info("Anon debug UnauthorizedError", { user: req.user });
    log.error("User Unauthorized", {
      context: 'unauthorizedError',
      user: toJson(req.user),
      err: 'Unauthorized',
      errorStatus: 401
    });
    res.sendStatus(401);
  } else {
    next(err);
  }
});

// catch 404 and forward to error handler
app.use(function check4040errors(req, res, next) {
  var err = new Error('Not Found');
  err.status = 404;
  log.warn("Not Found", {context: 'notFound', user: toJson(req.user), err: 'Not Found', errorStatus: 404});
  next(err);
});

// Error handlers
app.use(function generalErrorHandler(err, req, res, next) {
  var status = err.status || 500;
  if (status == 404) {
    log.warn("Not found", {context: 'notFound', errorStatus: status, url: req.url});
  } else {
    log.error("General Error", {
      context: 'generalError',
      user: req.user ? toJson(req.user) : null,
      err: err,
      errStack: err.stack,
      errorStatus: status
    });
  }
  err.url = req.url;
  err.params = req.params;
  if (status != 404 && status != 401) {
    if (airbrake) {
      airbrake.notify(err).then((airbrakeErr)=> {
        if (airbrakeErr.error) {
          log.error("AirBrake Error", {
            context: 'airbrake',
            user: toJson(req.user),
            err: airbrakeErr.error,
            errorStatus: 500
          });
        }
        res.sendStatus(status);
      });
    } else {
      res.sendStatus(status);
    }
  } else {
    res.sendStatus(status);
  }
});

if (airbrake) {
  app.use(airbrakeExpress.makeErrorHandler(airbrake));
}

var server = app.listen(app.get('port'), function () {
  log.info('Your Priorities server listening on port ' + server.address().port);
});

module.exports = app;
