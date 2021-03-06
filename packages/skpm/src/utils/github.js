import path from 'path'
import fs from 'fs'
import parseAuthor from 'parse-author'
import { request, streamingRequest } from './request'

function options(token, url, method) {
  return {
    method: method || 'GET',
    url,
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Token ${token}`,
      'User-Agent': 'SKPM-Release-Agent',
    },
  }
}

function getRegistryRepo(token, skpmConfig, repo) {
  const [, name] = repo.split('/')
  return request(
    options(
      token,
      'https://api.github.com/repos/sketchplugins/plugin-directory/contents/plugins.json'
    )
  )
    .then(data => {
      const file = JSON.parse(data)
      const buf = Buffer.from(file.content, 'base64')
      return {
        plugins: JSON.parse(buf.toString('utf-8')),
        file,
      }
    })
    .then(res => ({
      existingPlugin: res.plugins.find(
        plugin => plugin.title === skpmConfig.name || name === plugin.name
      ),
      plugins: res.plugins,
      file: res.file,
    }))
}

export default {
  getUser(token) {
    return request(options(token, 'https://api.github.com/user'))
  },
  getRepo(token, repo) {
    if (!token) {
      return Promise.reject(
        new Error('You are not logged in. Please run `skpm login` first.')
      )
    }
    return request(options(token, `https://api.github.com/repos/${repo}`)).then(
      res => {
        const permissions = JSON.parse(res).permissions || {}
        if (!permissions.push) {
          throw new Error(
            `You don't have the right permissions on the repo. Need the "push" permission and only got:\n' ${JSON.stringify(
              permissions,
              null,
              '  '
            )}`
          )
        }
      }
    )
  },
  createDraftRelease(token, repo, tag) {
    const opts = options(
      token,
      `https://api.github.com/repos/${repo}/releases`,
      'POST'
    )
    opts.json = {
      tag_name: tag,
      name: tag,
      draft: true,
    }
    return request(opts)
  },
  updateAsset(token, repo, releaseId, assetName, fileName) {
    const opts = options(
      token,
      `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(
        fileName
      )}&label=${encodeURIComponent(
        'To install: download this file, unzip and double click on the .sketchplugin'
      )}`,
      'POST'
    )
    const asset = path.join(process.cwd(), assetName)
    const stat = fs.statSync(asset)
    const rd = fs.createReadStream(asset)
    opts.headers['Content-Type'] = 'application/zip'
    opts.headers['Content-Length'] = stat.size

    return streamingRequest(rd, opts)
  },
  publishRelease(token, repo, releaseId) {
    const opts = options(
      token,
      `https://api.github.com/repos/${repo}/releases/${releaseId}`,
      'PATCH'
    )
    opts.json = {
      draft: false,
    }
    return request(opts)
  },

  getRegistryRepo,

  // get the upstream plugins.json
  // if we haven't added the plugin yet
  // get or create a fork
  // delete any existing branch for this plugin
  // check if origin master is up to date with upstream (update otherwise)
  // branch
  // update origin plugins.json
  // open PR
  addPluginToPluginsRegistryRepo(token, skpmConfig, repo, upstreamPluginJSON) {
    const [owner, name] = repo.split('/')

    function deleteExistingBranch(fork) {
      const opts = options(
        token,
        `https://api.github.com/repos/${fork.full_name}/git/refs/heads/${repo}`,
        'DELETE'
      )
      return request(opts).catch(() => {})
    }

    function getOriginBranchSHA(fork) {
      return deleteExistingBranch(fork).then(() =>
        Promise.all([
          request(
            options(
              token,
              `https://api.github.com/repos/${
                fork.full_name
              }/git/refs/heads/master`
            )
          ),
          request(
            options(
              token,
              `https://api.github.com/repos/sketchplugins/plugin-directory/git/refs/heads/master`
            )
          ),
        ])
          .then(([originData, upstreamData]) => ({
            originSHA: JSON.parse(originData).object.sha,
            upstreamSHA: JSON.parse(upstreamData).object.sha,
          }))
          .then(({ originSHA, upstreamSHA }) => {
            if (originSHA === upstreamSHA) {
              return originSHA
            }
            // merge upstream master so that there is no conflicts
            const opts = options(
              token,
              `https://api.github.com/repos/${
                fork.full_name
              }/git/refs/heads/master`,
              'PATCH'
            )
            opts.json = {
              sha: upstreamSHA,
            }
            return request(opts).then(() => upstreamSHA)
          })
          .then(headSHA => {
            const opts = options(
              token,
              `https://api.github.com/repos/${fork.full_name}/git/refs`,
              'POST'
            )
            opts.json = {
              ref: `refs/heads/${repo}`,
              sha: headSHA,
            }
            return request(opts)
          })
          .then(() =>
            // now we just need to get the SHA of the file in the branch
            request(
              options(
                token,
                `https://api.github.com/repos/${
                  fork.full_name
                }/contents/plugins.json?ref=${repo}`
              )
            ).then(data => JSON.parse(data).sha)
          )
      )
    }

    function forkUpstream(res) {
      return request(
        options(
          token,
          'https://api.github.com/repos/sketchplugins/plugin-directory/forks',
          'POST'
        )
      )
        .then(fork => JSON.parse(fork))
        .then(fork =>
          getOriginBranchSHA(fork).then(sha => ({
            pluginUpdate: res,
            fork,
            sha,
          }))
        )
    }

    function updatePluginJSON({ pluginUpdate, fork, sha }) {
      const opts = options(
        token,
        `https://api.github.com/repos/${fork.full_name}/contents/plugins.json`,
        'PUT'
      )

      const plugin = {
        title: skpmConfig.title || skpmConfig.name,
        description: skpmConfig.description,
        name,
        owner,
        appcast: `https://raw.githubusercontent.com/${repo}/master/.appcast.xml`,
        homepage: skpmConfig.homepage || `https://github.com/${repo}`,
      }

      if (skpmConfig.author) {
        let { author } = skpmConfig
        if (typeof skpmConfig.author === 'string') {
          author = parseAuthor(skpmConfig.author)
        }
        plugin.author = author.name
      }

      const newPlugins = JSON.stringify(
        pluginUpdate.plugins.concat(plugin),
        null,
        2
      )
      let buf
      if (typeof Buffer.from === 'function') {
        // Node 5.10+
        buf = Buffer.from(newPlugins, 'utf-8')
      } else {
        // older Node versions
        buf = new Buffer(newPlugins, 'utf-8') // eslint-disable-line
      }
      opts.json = {
        path: 'plugins.json',
        message: `Add the ${repo} plugin`,
        committer: {
          name: 'skpm-bot',
          email: 'bot@skpm.io',
        },
        sha,
        content: buf.toString('base64'),
        branch: repo,
      }

      return request(opts).then(res => ({
        res,
        fork,
        sha,
      }))
    }

    function openPR({ fork }) {
      const prOptions = options(
        token,
        'https://api.github.com/repos/sketchplugins/plugin-directory/pulls',
        'POST'
      )
      prOptions.json = {
        title: `Add the ${repo} plugin`,
        head: `${fork.owner.login}:${repo}`,
        body: `Hello Team :wave:

The plugin is [here](${skpmConfig.homepage ||
          `https://github.com/${repo}`}) if you want to have a look.

Hope you are having a great day :)
`,
        base: 'master',
        maintainer_can_modify: true,
      }
      return request(prOptions)
    }

    return forkUpstream(upstreamPluginJSON)
      .then(updatePluginJSON)
      .then(openPR)
  },
}
