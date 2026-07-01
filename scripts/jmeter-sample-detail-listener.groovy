import groovy.json.JsonOutput

def path = props.get('runSampleDetailsLog')
if (!path) return

def result = sampleEvent?.result ?: sampleResult
if (!result) return

def maxLen = (props.get('runSampleDetailsMaxChars') ?: '32768').toInteger()

def clip = { String text ->
    if (text == null) return [text: '', truncated: false]
    if (text.length() <= maxLen) return [text: text, truncated: false]
    return [text: text.substring(0, maxLen), truncated: true]
}

def requestClip = clip(result.getSamplerData() ?: '')
def responseClip = clip(result.getResponseDataAsString() ?: '')

def failureMessage = ''
try {
    failureMessage = result.getFirstAssertionFailureMessage() ?: ''
} catch (ignored) {
    failureMessage = result.getResponseMessage() ?: ''
}

def entry = [
    timeStamp   : result.getTimeStamp(),
    elapsed     : result.getTime(),
    label       : result.getSampleLabel() ?: '',
    threadName  : result.getThreadName() ?: '',
    success     : result.isSuccessful(),
    responseCode: result.getResponseCode() ?: '',
    responseMessage: result.getResponseMessage() ?: '',
    failureMessage: failureMessage,
    url         : result.getUrlAsString() ?: '',
    request     : requestClip.text,
    requestTruncated: requestClip.truncated,
    response    : responseClip.text,
    responseTruncated: responseClip.truncated
]

def line = JsonOutput.toJson(entry)
def file = new File(path)
file.parentFile?.mkdirs()

synchronized('biq-run-sample-details') {
    file.withWriterAppend('UTF-8') { writer ->
        writer.println(line)
    }
}
