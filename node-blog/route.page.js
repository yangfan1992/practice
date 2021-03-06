var express = require('express');
var router = express.Router();
var PostModel = require('./models/post');
var marked = require('marked');
var config = require('./config');
var auth = require('./middlewares/auth');

router.get('/', function(req, res, next) {
  res.render('index', {title: 'index'});
});

router.get('/posts', function(req, res, next) {
  res.render('posts', {title: 'posts'});
});

router.get('/posts/new', auth.adminRequired, function(req, res, next) {
  res.render('new');
});

router.get('/posts/show', function(req, res, next) {
  var id = req.query.id;
  PostModel.findOne({_id:id}, function(err, post) {
    post.content = marked(post.content);
    res.render('show', {post});
  });
});

router.get('/posts/edit', function (req, res, next) {
  var id = req.query.id;

  res.render('edit', { id });
});

router.get('/signup', function(req, res, next) {
  res.render('signup');
});

router.get('/signin', function (req, res, next) {
  res.render('signin');
});

router.get('/signout', function (req, res, next) {
  res.clearCookie(config.cookieName, { path: '/' });
  res.redirect('/');
});

module.exports = router;