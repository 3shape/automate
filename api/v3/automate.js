"use-strict";

// Using nodejs
const parseArgs = require("minimist");
const fetch = require("node-fetch"); // node-fetch@2
const fs = require('fs/promises');
const FormData = require('form-data');
const JsZip = require("jszip");

const args = process.argv.slice(2);
const argv = parseArgs(args);
const email = argv.email;
const password = argv.password;
const upperJawPath = argv.upperjaw;
const lowerJawPath = argv.lowerjaw;
const outputDirectory = argv.output;
const existingOrderId = argv.orderid;
const unns = argv.unns?.toString()?.split(",").map(i => parseInt(i, 10));

if (!email || !password) {
    throw Error("Please supply email and password!");
}

if (!existingOrderId && (!upperJawPath || !lowerJawPath || !unns)) {
    throw Error("Please supply paths to upper and lower jaws and the unns. Alternatively provide an existing order ID!");
}

if (!outputDirectory) {
    throw Error("Please supply a path to the output");
}

const rawEndpoint = argv._[0] ?? "https://automate.3shape.com";
const endpoint = getEndpoint(rawEndpoint);
const apiEndpoint = `${endpoint}/api/v3`;
const regexp = /[\\|\/]/;
const upperJawScanName = upperJawPath?.split(regexp)?.pop();
const lowerJawScanName = lowerJawPath?.split(regexp)?.pop();
if (!existingOrderId && (!upperJawScanName || !lowerJawScanName)) {
    throw Error("Scans paths not correct!");
}

const jsonHeader = ['Content-Type', 'application/json'];


/**
 * Endpoint parsing
 * @param {string} rawEndpoint
 * @returns {string} endpoint
 */
function getEndpoint(rawEndpoint) {

    if (rawEndpoint.endsWith('/')) {
        rawEndpoint = rawEndpoint.slice(0, -1);
    }

    if (!rawEndpoint.startsWith("http"))
    {
        rawEndpoint = `https://${rawEndpoint}`;
    }

    return rawEndpoint;
}


/**
 * Get antiforgery and verification token headers
 * @param {Headers} headers
 * @returns {[[string]]}
 */
async function getAntiforgeryHeaders(headers) {

    const response = await fetch(`${apiEndpoint}/xsrf/`, {
        headers: headers ?? []
    });
    if (!response.ok) {
        throw Error(`Unable to get antiforgery token! [${response.status}]`);
    }

    const cookies = getCookies(response);
    const content = await response.json();
    const verificationTokenHeader = [content.headerName, content.requestToken];
    const antiforgeryToken = cookies[0];
    const antiforgeryCookie = makeCookieHeader(antiforgeryToken);

    return [antiforgeryCookie, verificationTokenHeader];
}


/**
 * Get cookies from response
 * @param {response} response
 * @returns {[string]} cookies
 */
function getCookies(response) {
    const headers = response.headers;
    const cookie = headers.get('set-cookie');
    return cookie.split(';');
}


/**
 * Make a cookie header
 * @param {[string]} parts
 * @returns {[string]} cookieHeader
 */
function makeCookieHeader(token) {
    return ['cookie', token];
}


/**
 * Get the authentication headers after login
 * @param {response} loginResponse
 * @returns {Headers} headers
 */
async function getAuthHeader(loginResponse) {
    const authToken = getCookies(loginResponse)[0];
    const authCookieHeader = makeCookieHeader([authToken]);
    return authCookieHeader;
}


/**
 * Login
 * @returns {Headers} headers
 */
async function login() {

    // get antiforgery and verification token headers so that we can make POST requests
    const initialAntiforgeryHeaders = await getAntiforgeryHeaders([]);

    const loginHeaders = initialAntiforgeryHeaders.concat([jsonHeader]);

    const loginBody = { email: email, password: password };
    const loginResponse = await fetch(`${apiEndpoint}/Login`, {

            method: "POST",
            headers: loginHeaders,
            body: JSON.stringify(loginBody)
        });

    if (!loginResponse.ok) {
        throw Error(`Unable to log in! [${response.status}]`);
    }

    // get the authentication header
    const authHeader = await getAuthHeader(loginResponse);

    // need fresh antiforgery headers after login
    const antiforgeryHeaders = await getAntiforgeryHeaders([authHeader]);

    const headers = antiforgeryHeaders.concat([authHeader]);

    console.log(`Successfully logged in as ${email}.`);

    return headers;
}


/**
 * Get the scan zip file as a buffer
 * @returns {Buffer} buffer
 */
 async function getScanZipAsBuffer() {

    // we now create a zip containing the scans
    // in your application the files might already be zipped
    const zip = new JsZip();
    const upperContent = await fs.readFile(upperJawPath);
    const lowerContent = await fs.readFile(lowerJawPath);

    zip.file(upperJawScanName, upperContent);
    zip.file(lowerJawScanName, lowerContent);

    const arrayBuffer = await zip.generateAsync({
        type: "arraybuffer",
        streamFiles: true,
        compression: "DEFLATE", compressionOptions: { level: 5 }
    });

    // some manipulations to be able to append to form data
    // this is somewhat framework specific
    const buffer = Buffer.from(arrayBuffer);

    return buffer;
}


/**
 * Get the content for uploading
 * @param {string} orderId
 * @param {*} orderFile
 * @returns {FormData} formData
 */
async function getUploadContent(orderId) {

    const buffer = await getScanZipAsBuffer();

    const fileName = `${orderId}.zip`;
    const fileType = "application/zip";

    const formData = new FormData();
    formData.append("file", buffer, { filename: fileName, 'Content-Type': fileType });

    return formData;
}


/**
 * Get content-type header for uploading
 * @param {FormData} formData
 * @returns {[string]} header
 */
function getUploadContentTypeHeader(formData) {
    const contentType = formData.getHeaders()["content-type"];
    const contentTypeHeader = ['Content-Type', contentType];
    return contentTypeHeader;
}


/**
 * Create the order
 * @param {Headers} headers
 * @returns {string} orderId
 */
async function createOrder(headers) {

    // we now check to see if the order can be designed by automate
    const orderInfo = {

        name: "Order", // The name of the order
        // source: "{YOUR ORGANIZATION}", // The name of your organization
        unns: unns,
        toothNumberingSystem: "unn", // This will be the formatting of any eventual messages and quality control images
        upperJawScanName: upperJawScanName,
        lowerJawScanName: lowerJawScanName,
        designPreferences: {
            material: "Zirconia", // Needs to more or less match a material on the platform
            //turnaroundTimeSeconds,
            //occlusionDistance,
            //contactsDistance,
            //removeUndercuts,
        }
    };

    const response = await fetch(`${apiEndpoint}/Orders/Crown`,
    {
        method: "POST",
        headers: headers.concat([jsonHeader]),
        body: JSON.stringify(orderInfo)
    });

    if (!response.ok) {
        throw Error(await response.text());
    }

    const order = await response.json();

    console.log(`New order created with order ID ${order.id}.`);

    return order.id; // the order id on Automate
}


/**
 * Submit the order for desing
 * @param {Headers} headers
 * @param {string} orderId
 */
async function submitOrder(headers, orderId) {

    const formData = await getUploadContent(orderId);
    const contentTypeHeader = getUploadContentTypeHeader(formData);

    // Also possible to specify turnaround time here, otherwise uses default
    const endpoint = `${apiEndpoint}/Orders/${orderId}/Submit`;

    // the api also supports progress notifications not implemented here
    const response = await fetch(endpoint, {
        method: "POST",
        headers: headers.concat([contentTypeHeader]),
        body: formData
    });

    if (!response.ok) {
        throw Error(`Upload failed for order ${orderId}! [${response.status}]`);
    }

    console.log(`Successfully submitted order ${orderId} for design.`);
}


/**
 * Send the order for desgin
 * @param {Headers} headers
 * @returns {string} orderId
 */
async function send(headers) {

    const orderId = await createOrder(headers);

    await submitOrder(headers, orderId);

    return orderId;
}


/**
 * Get the status of order
 * @param {string} orderId
 * @param {Headers} headers
 * @returns {*} status
 */
 async function getStatus(orderId, headers) {

    const response = await fetch(`${apiEndpoint}/Orders/${orderId}/Status`, {
        headers: headers.concat([jsonHeader])
    });

    if (!response.ok) {
        throw Error(`Unable to get status for order ${orderId}! [${response.status}]`);
    }

    const status = await response.json();
    return status.status;
}


/**
 * Wait for processing to finish
 * @param {string} orderId
 * @param {Headers} headers
 * @returns {*} status
 */
 async function waitForReady(orderId, headers) {

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    let status = await getStatus(orderId, headers);
    console.log(`Order ${orderId} is ${status.message}.`);

    while (status.processing) {
        await sleep(30000); // 30 second sleep
        status = await getStatus(orderId, headers);
        console.log(`Order ${orderId} is ${status.message}.`);
    }

    if (status.failed) {
        throw Error(`Processing failed for order ${orderId}!`);
    }

    console.log(`Order ${orderId} finished processing.`);
    return status;
}


/**
 * Review the order
 * @param {Headers} headers
 * @param {string} orderId
 * @param {string} action
 */
async function review(headers, orderId, action = "accept") {

    const request = { action: action };
    const response = await fetch(`${apiEndpoint}/Orders/${orderId}/Review`, {
        method: "POST",
        headers: headers.concat([jsonHeader]),
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        throw Error(`Unable to ${action} order ${orderId}! [${response.status}]`);
    }

    console.log(`Successfully ${action}ed order ${orderId}.`);
}


/**
 * Download the order
 * @param {Headers} headers
 * @param {string} orderId
 */
async function download(headers, orderId) {

    const response = await fetch(`${apiEndpoint}/Orders/${orderId}/Download`, {
        method: "GET",
        headers: headers.concat([jsonHeader])
    });

    if (!response.ok) {
        throw Error(`Unable to download order ${orderId}! [${response.status}]`);
    }

    const buffer = await response.buffer();

    await fs.writeFile(`${outputDirectory}\\${orderId}.zip`, buffer);

    console.log(`Order ${orderId} successfully downloaded to ${outputDirectory}.`);
}


/**
 * Accept and download the order
 * @param {Headers} headers
 * @param {string} orderId
 * @param {*} status
 */
async function acceptAndDownload(headers, orderId, status) {

    if (status.reviewable) {
        await review(headers, orderId, "accept"); // or "reject"
    }

    await download(headers, orderId);
}


(async() => {

    // quick check to fail early if there is any issue
    const checkResponse = await fetch(`${endpoint}/`);
    if (!checkResponse.ok) {
        throw Error(`Issues at endpoint! [${checkResponse.status}]`);
    }
    console.log(`Endpoint up and running.`);

    // log in and get the headers for any requests
    const headers = await login();

    const orderId = existingOrderId ? existingOrderId : await send(headers);

    // wait while the order is being processed
    const status = await waitForReady(orderId, headers);

    await acceptAndDownload(headers, orderId, status);
})();