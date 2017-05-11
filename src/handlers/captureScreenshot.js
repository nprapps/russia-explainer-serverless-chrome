import AWS from 'aws-sdk'
import Cdp from 'chrome-remote-interface'
import config from '../config'
import { log, sleep } from '../utils'
import slug from 'slug'


export async function captureScreenshotOfUrl (url) {
  const LOAD_TIMEOUT = (config && config.chrome.pageLoadTimeout) || 1000 * 60

  let result
  let loaded = false

  const loading = async (startTime = Date.now()) => {
    if (!loaded && Date.now() - startTime < LOAD_TIMEOUT) {
      await sleep(1000)
      await loading(startTime)
    }
  }

  const [tab] = await Cdp.List()
  const client = await Cdp({ host: '127.0.0.1', target: tab })

  const { Network, Page, Emulation, DOM } = client

  Network.requestWillBeSent((params) => {
    log('Chrome is sending request for:', params.request.url)
  })

  Page.loadEventFired(() => {
    loaded = true
  })

  if (config.logging) {
    Cdp.Version((err, info) => {
      console.log('CDP version info', err, info)
    })
  }

  try {
    await Promise.all([
      Network.enable(), // https://chromedevtools.github.io/debugger-protocol-viewer/tot/Network/#method-enable
      Page.enable(), // https://chromedevtools.github.io/debugger-protocol-viewer/tot/Page/#method-enable
    ])

    await Page.navigate({ url }) // https://chromedevtools.github.io/debugger-protocol-viewer/tot/Page/#method-navigate

    const viewportWidth = 600 * 2.0
    const viewportHeight = Math.ceil(viewportWidth * 0.525)

    // Set up viewport resolution, etc.
    const deviceMetrics = {
      width: viewportWidth,
      height: viewportHeight,
      deviceScaleFactor: 0,
      mobile: false,
      fitWindow: false,
    }
    await Emulation.setDeviceMetricsOverride(deviceMetrics)
    await Emulation.setVisibleSize({width: viewportWidth, height: viewportHeight})

    await loading()

    const screenshot = await Page.captureScreenshot()
    result = new Buffer(screenshot.data, 'base64')

  } catch (error) {
    console.error(error)
  }

  await client.close()

  return result
}

export default (async function captureScreenshotHandler (event) {
  const s3 = new AWS.S3()
  const { queryStringParameters: { id, slug } } = event
  const url = config.baseurl + id

  let screenshot

  log('Processing screenshot capture for', url)

  try {
    screenshot = await captureScreenshotOfUrl(url)
  } catch (error) {
    console.error('Error capturing screenshot for', url, error)
    throw new Error('Unable to capture screenshot')
  }

  const filename = "cardbuilder/screenshots/russian-explainer-" + slug + "-id-" + id + ".png"
  await s3.putObject({
    "ACL": "public-read",
    "Bucket": config.bucket,
    "Key": filename,
    "Body": screenshot,
    "ContentType": "image/png",
  }).promise()

  return {
    statusCode: 200,
    body: JSON.stringify({
      "url": "https://apps.npr.org" + "/" + filename
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  }
})
