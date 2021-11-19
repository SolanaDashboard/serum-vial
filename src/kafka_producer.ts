import {getDefaultMarkets} from "./helpers"
import { logger } from './logger'

const { Kafka } = require('kafkajs')

const kafka = new Kafka({
    clientId: 'serum-vial',
    brokers: ['b-1.sophon-streaming.3091su.c21.kafka.us-east-1.amazonaws.com:9092','b-2.sophon-streaming.3091su.c21.kafka.us-east-1.amazonaws.com:9092','b-3.sophon-streaming.3091su.c21.kafka.us-east-1.amazonaws.com:9092']
})

export const producer = kafka.producer()

export const create_kafka_topics = async () => {
    // Create topics ahead of time
    const markets = getDefaultMarkets()
    const admin = kafka.admin()

    for (const market of markets) {
        const kafka_topic = `serum_${market.name}`.replace('\/', '-')
        await admin.createTopics({
            waitForLeaders: true,
            topics: [
                {
                    topic: kafka_topic,
                    numPartitions: 1,
                    replicationFactor: 3,
                },
            ],
        }).catch(logger.error)
        logger.info('topic created: ' + kafka_topic)
    }
}
