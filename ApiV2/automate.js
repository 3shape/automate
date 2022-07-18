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
const apiEndpoint = `${endpoint}/api/v2`;
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
 * @returns
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
 * Get antiforgery token and verification token
 * @param {Headers} headers
 * @returns {}
 */
async function getTokens(headers) {

    const response = await fetch(`${apiEndpoint}/xsrf/get/`, {
        headers: headers ?? []
    });
    if (!response.ok) {
        throw Error("Unable to get antiforgery token!");
    }

    const cookies = getCookies(response);
    const content = await response.json();
    const verificationTokenHeader = [content.tokenName, content.token];
    const antiforgeryToken = cookies[0];

    return [antiforgeryToken, verificationTokenHeader];
}

/**
 * Get cookies
 * @param {response} response
 * @returns {[string]} cookies
 */
function getCookies(response) {
    const headers = response.headers;
    const cookie = headers.get('set-cookie');
    return cookie.split(';');
}

/**
 * Make the cookie header
 * @param {[string]} parts
 * @returns {[string]} cookieHeader
 */
function makeCookieHeader(parts) {
    const all = parts.join(';');
    return ['cookie', all];
}

/**
 * Get the final headers after login
 * @param {response} loginResponse
 * @returns {Headers} headers
 */
async function getFinalHeaders(loginResponse) {

    // some header and cookie management
    const loginToken = getCookies(loginResponse)[0];
    const tempCookie = makeCookieHeader([loginToken]);
    const [antiforgeryToken, verificationTokenHeader] = await getTokens([tempCookie]);
    const cookieHeader = makeCookieHeader([antiforgeryToken, loginToken]);
    return [cookieHeader, verificationTokenHeader];
}

/**
 * Get the content for uploading
 * @param {string} orderId
 * @param {*} orderFile
 * @returns
 */
async function getUploadContent(orderId, orderFile) {

    // we now create a zip containing the scans and order file
    const zip = new JsZip();
    const upperContent = await fs.readFile(upperJawPath/*, 'utf8'*/);
    const lowerContent = await fs.readFile(lowerJawPath/*, 'utf8'*/);

    zip.file(upperJawScanName, upperContent);
    zip.file(lowerJawScanName, lowerContent);
    zip.file(orderFile.name, orderFile.content);

    const arrayBuffer = await zip.generateAsync({
        type: "arraybuffer",
        streamFiles: true,
        compression: "DEFLATE", compressionOptions: { level: 5 }
    });

    const fileName = `${orderId}.zip`;
    const fileType = "application/zip";

    // some manipulations to append to form data
    // this is somewhat framework specific
    const buffer = Buffer.from(arrayBuffer);
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
 * Wait for processing to finish
 * @param {string} orderId
 * @param {Headers} headers
 * @returns
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
 * Get the status of order
 * @param {string} orderId
 * @param {Headers} headers
 * @returns {*} status
 */
async function getStatus(orderId, headers) {

    const response = await fetch(`${apiEndpoint}/Orders/Status/${orderId}`, {
        headers: headers.concat([jsonHeader])
    });

    if (!response.ok) {
        throw Error(`Unable to get status for order ${orderId}!`);
    }

    const status = await response.json();
    return status.status;
}

/**
 * Login
 * @returns {Headers} headers
 */
async function login() {

    // get antiforgery token and verification token so that we can make POST requests
    const [tempAntiforgeryToken, tempVerificationTokenHeader] = await getTokens([]);
    const loginHeaders = [['cookie', tempAntiforgeryToken], tempVerificationTokenHeader, jsonHeader];

    const loginBody = { email: email, password: password };
    const loginResponse = await fetch(`${apiEndpoint}/Authentication/Login`, {

            method: "POST",
            headers: loginHeaders,
            body: JSON.stringify(loginBody)
        });

    if (!loginResponse.ok) {
        throw Error("Unable to log in!");
    }

    // some header and cookie management
    const headers = await getFinalHeaders(loginResponse);

    console.log(`Successfully logged in as ${email}.`);

    return headers;
}

/**
 * Upload the order
 * @param {Headers} headers
 * @returns {string} orderId
 */
async function upload(headers) {

    // we now check to see if the order can be designed by automate
    const orderInfo = {

        name: "Order", // The name of the order
        orderCode: "SC", // SC: Single crown, NG: Nightguard
        source: "3rdParty", // The name of the organisation
        unns: unns,
        toothNumberingSystem: "unn", // This will be the formatting of any eventual messages and quality control images
        upperJawScanName: upperJawScanName,
        lowerJawScanName: lowerJawScanName,
        designPreferences: {
            material: "Zirconia", // Needs to more or less match a material on the platform
            //turnaroundSeconds,
            //occlusionDistance,
            //contactsDistance,
            //removeUndercuts,
        }
    };

    const qualificationResponse = await fetch(`${apiEndpoint}/Qualification/QualifyOrderInfo`,
    {
        method: "POST",
        headers: headers.concat([jsonHeader]),
        body: JSON.stringify(orderInfo)
    });

    // the error message shows any issues, if that is empty we are clear to continue
    const qualificationMessage = await qualificationResponse.json();
    if (qualificationMessage.errorMessage != "") {
        throw Error(qualificationMessage.errorMessage);
    }

    const orderId = qualificationMessage.orderId; // the order id on Automate
    const orderFile = qualificationMessage.orderFile;

    console.log(`New order created with order ID ${orderId}.`);

    const formData = await getUploadContent(orderId, orderFile);
    const contentTypeHeader = getUploadContentTypeHeader(formData);

    // Also possible to specify turnaround time here, otherwise uses default
    const uploadEndpoint = `${apiEndpoint}/Streaming/Upload/${orderId}`;
    // the api also supports progress notifications not implemented here
    const uploadResponse = await fetch(uploadEndpoint, {
        method: "POST",
        headers: headers.concat([contentTypeHeader]),
        body: formData
    });

    if (!uploadResponse.ok) {
        throw Error(`Upload failed for order ${orderId}!`);
    }

    return orderId;
}


/**
 * Download the order
 * @param {string} orderId
 * @param {*} status
 * @param {Headers} headers
 */
async function download(orderId, status, headers) {

    if (!status.accepted)
    {
        const acceptBody = { id: orderId }; // order id in the body for this request
        const acceptResponse = await fetch(`${apiEndpoint}/Results/Accept`, {
            method: "POST",
            headers: headers.concat([jsonHeader]),
            body: JSON.stringify(acceptBody)
        });

        if (!acceptResponse.ok) {
            throw Error(`Unable to accept order ${orderId}!`);
        }
    }

    const downloadResponse = await fetch(`${apiEndpoint}/Results/Download/${orderId}`, {
        method: "GET",
        headers: headers.concat([jsonHeader])
    });

    if (!downloadResponse.ok) {
        throw Error(`Unable to download order ${orderId}!`);
    }

    const buffer = await downloadResponse.buffer();

    await fs.writeFile(`${outputDirectory}\\${orderId}.zip`, buffer);

    console.log(`Order ${orderId} successfully downloaded to ${outputDirectory}.`);
}

(async() => {

    // quick check to fail early if there is any issue
    const checkResponse = await fetch(`${endpoint}/`);
    if (!checkResponse.ok) {
        throw Error("Issues at endpoint!");
    }
    console.log(`Endpoint up and running.`);

    // log in and get the headers for any requests
    const headers = await login();
    const orderId = existingOrderId ? existingOrderId : await upload(headers);
    // wait while the order is being processed
    const status = await waitForReady(orderId, headers);
    await download(orderId, status, headers);
})();