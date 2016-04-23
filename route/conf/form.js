// Router for /conf/:conf/form

var express = require('express');
var router = express.Router({ mergeParams: true });

var mongoose = require('mongoose');
var Conf = mongoose.model('Conf');
var Form = mongoose.model('Form');
var User = mongoose.model('User');
var Registrant = mongoose.model('Registrant');

var helpers = require('../helpers');

function checkFormPerm(conf, form, uid, level) {
  console.log(conf);
  console.log(form);
  return new Promise((resolve, reject) => {
    Form.findOne({
      conf: conf,
      name: form,
    }).exec((err, form) => {
      console.log(form);
      if(err) reject(err);
      else if(!form) resolve(false);
      else {
        switch(level) {
          case "viewer":
            if(form.viewers.indexOf(uid) != -1) return resolve(true);
          case "moderator":
            if(form.moderators.indexOf(uid) != -1) return resolve(true);
          case "admin":
            if(form.admins.indexOf(uid) != -1) return resolve(true);

            return resolve(false);
            break;
          default:
            return reject(new Error("No such permission level"));
        }
      }
    });
  });
}

/**
 * Creation
 */

router.post('/',
  helpers.hasPerms(['form.creation']),
  helpers.hasFields(['id', 'title']),
  (req, res, next) => {
    Form.findOne({
      conf: req.params.conf,
      name: req.body.id,
    }).exec((err, doc) => {
      if(err) return next(err);
      else if(doc) return res.send({ error: "DuplicatedId" });
      else {
        Form.insert({
          conf: req.params.conf,
          name: req.body.id,
          title: req.body.title,
        })
      }
    });
  });

/**
 * Content
 */
router.route('/:form')
.get((req, res, next) => {
  Form.findOne({
    conf: req.params.conf,
    name: req.params.form
  }).lean().exec((err, doc) => {
    if(err) return next(err);
    else if(!doc)
      return res.sendStatus(404);
    else {
      var role = 'applicant';
      if(doc.viewers.indexOf(req.user._id) != -1) role = 'viewer';
      if(doc.moderators.indexOf(req.user._id) != -1) role = 'moderator';
      if(doc.admins.indexOf(req.user._id) != -1) role = 'admin';

      return res.send({
        content: doc.content,
        status: doc.status,
        title: doc.title,
        role,
      });
    }
  });
});

router.route('/:form/content')
.post(
  helpers.hasFields(['content', 'title']),
  (req, res, next) => {
    Form.findOneAndUpdate({
      conf: req.params.conf,
      name: req.params.form,
      admins: req.user._id,
    }, {
      content: req.body.content,
      title: req.body.title,
    }).exec((err, doc) => {
      if(err) return next(err);
      else if(!doc) return res.sendStatus(404);
      else return res.send({ msg: 'OperationSuccessful' });
    });
  }
);

/**
 * Submissions
 */
router.get('/:form/submissions',
  (req, res, next) => {
    checkFormPerm(req.params.conf, req.params.form, req.user._id, "viewer").then(result => {
      if(!result) return res.sendStatus(403);

      Registrant.find({
        conf: req.params.conf,
        form: req.params.form
      }, {
        _id: 0,
        user: 1,
        status: 1,
        locked: 1,
      }).lean().exec((err, rdoc) => {
        if(err) return next(err);
        else {
          var idList = rdoc.map(e => e.user);

          User.find({
            _id: { $in: idList },
          }, {
            realname: 1
          }).exec((err, udoc) => {
            if(err) return next(err);
            else {
              var umap = {};
              udoc.forEach(e => {
                umap[e._id] = e.realname;
              });
              rdoc.forEach(e => e.realname = umap[e.user]);
              return res.send(rdoc);
            }
          });

        }
      });
    }).catch(e => {
      return next(e);
    });
  });

router.route('/:form/submission/:user(\\d+)')
.get((req, res, next) => {
  new Promise((resolve, reject) => {
    if(req.params.user == req.user._id) return resolve(true);
    else return checkFormPerm(req.params.conf, req.params.form, req.user._id, 'viewer').then(resolve).catch(reject);
  }).then(result => {
    if(!result) res.sendStatus(403);
    else {
      Registrant.findOne({
        conf: req.params.conf,
        form: req.params.form,
        user: req.params.user
      }, {
        _id: false,
        user: true,
        status: (req.params.user == req.user._id ? false : true), //TODO: show status to user after archived
        submission: true,
        locked: true,
      }).lean().exec((err, doc) => {
        if(err) return next(err);
        else if(!doc) return res.send({ submission: {}, locked: false, new: true}); // Indicates that it is not saved
        else return res.send(doc);
      });
    }
  }).catch(e => next(e));
})
.post(
  helpers.hasFields(['submission']),
  (req, res, next) => {
    new Promise((resolve, reject) => {
      Form.findOne({
        conf: req.params.conf,
        name: req.params.form,
      }).exec((err, form) => {
        if(err) return reject(err);
        else if(!form)
          return res.sendStatus(404);
        else {
          if(form.admins.indexOf(req.user._id) != -1) return resolve({
            role: 'admin',
            initStatus: form.submissionStatus[0],
            formOpen: form.status == 'open'
          });
          else if(req.params.user == req.user._id) return resolve({
            role: 'user',
            initStatus: form.submissionStatus[0],
            formOpen: form.status == 'open'
          });
          else return resolve(false);
        }
      })
    }).then(result => {
      if(!result) res.sendStatus(403);
      else {
        Registrant.findOne({
          conf: req.params.conf,
          form: req.params.form,
          user: req.params.user
        }).exec((err, doc) => {
          if(err) return next(err);
          else if(!doc) {
            if(result.formOpen) {
              Registrant.insert({
                conf: req.params.conf,
                form: req.params.form,
                user: req.params.user,
                status: result.initStatus,
                //TODO: sanitize
                submission: req.body.submission,
              }).exec((err, ndoc) => {
                res.send({ msg: "OperationSuccessful" });
              });
            }
          } else {
            if(doc.locked && result.role == 'user')
              res.sendStatus(403);
            else {
              doc.submission = JSON.stringify(req.body.submission);
            }
          }
        });
      }
    }).catch(e => next(e));
  });

router.route('/:form/submission/:user/lock')
.put((req, res, next) => {
  checkFormPerm(req.params.conf, req.params.form, req.user._id, 'moderator').then(result => {
    if(!result) return res.sendStatus(403);
    else {
      Registrant.findOneAndUpdate({
        conf: req.params.conf,
        form: req.params.form,
        user: req.params.user,
      }, {
        $set: { locked: true }
      }).exec((err, doc) => {
        if(err) return next(err);
        else if(!doc) res.sendStatus(404);
        else res.send({ msg: "OperationSuccessful" });
      })
    }
  });
})
.delete((req, res, next) => {
  checkFormPerm(req.params.conf, req.params.form, req.user._id, 'moderator').then(result => {
    if(!result) return res.sendStatus(403);
    else {
      Registrant.findOneAndUpdate({
        conf: req.params.conf,
        form: req.params.form,
        user: req.params.user,
      }, {
        $set: { locked: false }
      }).exec((err, doc) => {
        if(err) return next(err);
        else if(!doc) res.sendStatus(404);
        else res.send({ msg: "OperationSuccessful" });
      })
    }
  });
})

router.route('/:form/submission/:user/note')
.get((req, res, next) => {
  checkFormPerm(req.params.conf, req.params.form, req.user._id, 'moderator').then(result => {
    if(!result) return res.sendStatus(403);
    else {
      Registrant.findOne({
        conf: req.params.conf,
        form: req.params.form,
        user: req.params.user,
      }, {
        note: 1
      }).exec((err, doc) => {
        if(err) return next(err);
        else if(!doc) res.sendStatus(403);
        else return res.send({ note: doc.note });
      });
    }
  });
})
.post(
  helpers.hasFields(['note']),
  (req, res, next) => {
    checkFormPerm(req.params.conf, req.params.form, req.user._id, 'moderator').then(result => {
      if(!result) return res.sendStatus(403);
      else {
        Registrant.findOneAndUpdate({
          conf: req.params.conf,
          form: req.params.form,
          user: req.params.user,
        }, {
          $set: { note: req.body.note }
        }).exec((err, doc) => {
          if(err) return next(err)
          else res.send({ msg: "OperationSuccessful" });
        })
      }
    });
  });

/**
 * Opening, closeing and archiving
 */

const actionStatusMap = {
  close: 'closed',
  open: 'open',
}

router.put('/:form/settings/:action(close|open)',
  (req, res, next) => {
    Form.findOneAndUpdate({
      conf: req.params.conf,
      name: req.params.form,
      admins: req.user._id,
      status: { $ne: 'archived' },
    }, {
      $set: {
        status: actionStatusMap[req.params.action],
      }
    }).exec((err, doc) => {
      if(err) return next(err);
      else if(!doc) return res.sendStatus(404);
      else return res.send({ msg: "OperationSuccessful" });
    });
  });

router.put('/:form/settings/archive',
  (req, res, next) => {
    //TODO: archive data
    Form.findOneAndUpdate({
      conf: req.params.conf,
      name: req.params.form,
      admins: req.user._id,
    }, {
      $set: {
        status: 'archived',
      }
    }).exec((err, doc) => {
      if(err) return next(err);
      else if(!doc) return res.sendStatus(404);
      else return res.send({ msg: "OperationSuccessful" });
    });
  });

/**
 * Settings
 */
router.post('/:form/settings/permissions',
  helpers.hasPerms(['form.permission']),
  helpers.hasFields(['viewers', 'moderators', 'admins']),
  (req, res, next) => {
    //TODO: lint the input
    
    Form.findOneAndUpdate({
      conf: req.params.conf,
      name: req.params.form,
    }, {
      $set: {
        viewers: req.body.viewers,
        moderators: req.body.moderators,
        admins: req.body.admins,
      }
    }).exec((err, doc) => {
      if(err) return next(err);
      else if(!doc) return res.sendStatus(404);
      else return res.send({ msg: "OperationSuccessful" });
    });
  })

//TODO: finish the following APIs
// Hooks
router.post('/:form/settings/hooks', (req, res, next) => res.sendStatus(501));
// Meta-data for submissions
router.post('/:form/settings/meta', (req, res, next) => res.sendStatus(501));

module.exports = router;
