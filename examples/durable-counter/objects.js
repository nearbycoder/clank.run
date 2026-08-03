import { defineDurableObject, s } from "@clank.run/framework";
export const Counter = defineDurableObject({
    name: "example_counters",
    description: "A stable counter whose calls are serialized by ID.",
    state: s.object({
        value: s.number({
            integer: true
        }),
        lastChangedAt: s.nullable(s.number({
            integer: true,
            min: 0
        }))
    }),
    initial: ()=>({
            value: 0,
            lastChangedAt: null
        }),
    methods: ({ query, mutation })=>({
            read: query({
                args: {},
                returns: s.object({
                    value: s.number({
                        integer: true
                    }),
                    lastChangedAt: s.nullable(s.number({
                        integer: true,
                        min: 0
                    }))
                }),
                description: "Read this counter.",
                agent: {
                    title: "Read counter",
                    idempotent: true
                },
                handler: ({ storage })=>storage.get()
            }),
            add: mutation({
                args: {
                    amount: s.number({
                        integer: true,
                        min: -1_000,
                        max: 1_000
                    })
                },
                returns: s.number({
                    integer: true
                }),
                description: "Atomically add an amount to this counter.",
                agent: {
                    title: "Add to counter",
                    idempotent: true
                },
                handler: ({ storage }, { amount })=>{
                    const next = {
                        value: storage.get().value + amount,
                        lastChangedAt: Date.now()
                    };
                    storage.set(next);
                    return next.value;
                }
            })
        })
});


//# sourceURL=/home/nearby/Sites/clank/examples/durable-counter/objects.ts