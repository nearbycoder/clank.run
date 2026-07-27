import { defineAuth, defineBackend, defineDatabase, defineTable, DatabaseConflictError, s } from "@clank.run/framework";
const environment = globalThis.process?.env;
const authPepper = environment?.CLANK_AUTH_PEPPER ?? environment?.PROACT_AUTH_PEPPER;
export const auth = defineAuth({
    // Keep the pepper server-only. The browser imports this module as a type, never as code.
    password: authPepper ? {
        pepper: authPepper
    } : undefined
});
export const databaseSchema = defineDatabase({
    profiles: defineTable({
        displayName: s.string({
            min: 1,
            max: 120
        })
    }).owned(),
    todos: defineTable({
        title: s.string({
            min: 1,
            max: 160
        }),
        done: s.boolean()
    }).owned().index("by_done", [
        "done"
    ])
});
const nonEmptyTitle = s.refine(s.string({
    max: 160
}), (value)=>value.trim().length > 0, "Todo titles cannot be empty.");
const nonEmptyDisplayName = s.refine(s.string({
    max: 120
}), (value)=>value.trim().length > 0, "Display names cannot be empty.");
const documentVersion = s.number({
    integer: true,
    min: 1
});
export const backend = defineBackend({
    schema: databaseSchema,
    auth
}).functions(({ query, mutation })=>({
        profile: {
            get: query({
                description: "Read the signed-in user's profile.",
                args: {},
                handler: ({ db })=>db.table("profiles").query().orderBy("_creationTime", "asc").first()
            }),
            update: mutation({
                description: "Create or update the signed-in user's display name.",
                args: {
                    displayName: nonEmptyDisplayName,
                    version: s.nullable(documentVersion)
                },
                agent: {
                    destructive: false
                },
                handler: ({ db }, { displayName, version })=>{
                    const value = displayName.trim();
                    const profile = db.table("profiles").query().orderBy("_creationTime", "asc").first();
                    if (version === null) {
                        if (profile) {
                            throw new DatabaseConflictError("profiles", profile._id, null, profile._version);
                        }
                        return db.table("profiles").insert({
                            displayName: value
                        });
                    }
                    if (!profile) {
                        throw new DatabaseConflictError("profiles", "profile", version, null);
                    }
                    return db.table("profiles").patch(profile._id, {
                        displayName: value
                    }, {
                        ifVersion: version
                    });
                }
            })
        },
        todos: {
            list: query({
                description: "List the signed-in user's todos.",
                args: {},
                handler: ({ db })=>db.table("todos").query().orderBy("_creationTime", "asc").collect()
            }),
            add: mutation({
                description: "Create a todo for the signed-in user.",
                args: {
                    title: nonEmptyTitle
                },
                agent: {
                    destructive: false
                },
                handler: ({ db }, { title })=>db.table("todos").insert({
                        title: title.trim(),
                        done: false
                    })
            }),
            setDone: mutation({
                description: "Mark one todo complete or incomplete.",
                args: {
                    id: s.id("todos"),
                    done: s.boolean(),
                    version: documentVersion
                },
                agent: {
                    destructive: false,
                    idempotent: true
                },
                handler: ({ db }, { id, done, version })=>db.table("todos").patch(id, {
                        done
                    }, {
                        ifVersion: version
                    })
            }),
            rename: mutation({
                description: "Rename one todo.",
                args: {
                    id: s.id("todos"),
                    title: nonEmptyTitle,
                    version: documentVersion
                },
                agent: {
                    destructive: false
                },
                handler: ({ db }, { id, title, version })=>db.table("todos").patch(id, {
                        title: title.trim()
                    }, {
                        ifVersion: version
                    })
            }),
            remove: mutation({
                description: "Permanently remove one todo.",
                args: {
                    id: s.id("todos"),
                    version: documentVersion
                },
                agent: {
                    destructive: true
                },
                handler: ({ db }, { id, version })=>db.table("todos").delete(id, {
                        ifVersion: version
                    })
            }),
            clearCompleted: mutation({
                description: "Permanently remove every completed todo.",
                args: {},
                agent: {
                    destructive: true
                },
                handler: ({ db })=>{
                    const completed = db.table("todos").query().where("done", true).collect();
                    for (const todo of completed){
                        db.table("todos").delete(todo._id, {
                            ifVersion: todo._version
                        });
                    }
                    return completed.length;
                }
            })
        }
    }));


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9hdXRoLXRvZG8vYmFja2VuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxTQUNFLFVBQVUsRUFDVixhQUFhLEVBQ2IsY0FBYyxFQUNkLFdBQVcsRUFDWCxxQkFBcUIsRUFDckIsQ0FBQyxRQUVJLHVCQUF1QjtBQUU5QixNQUFNLGNBQWMsQUFBQyxXQUVsQixPQUFPLEVBQUU7QUFDWixNQUFNLGFBQWEsYUFBYSxxQkFBcUIsYUFBYTtBQUVsRSxPQUFPLE1BQU0sT0FBTyxXQUFXO0lBQzdCLHlGQUF5RjtJQUN6RixVQUFVLGFBQWE7UUFBRSxRQUFRO0lBQVcsSUFBSTtBQUNsRCxHQUFHO0FBRUgsT0FBTyxNQUFNLGlCQUFpQixlQUFlO0lBQzNDLFVBQVUsWUFBWTtRQUNwQixhQUFhLEVBQUUsTUFBTSxDQUFDO1lBQUUsS0FBSztZQUFHLEtBQUs7UUFBSTtJQUMzQyxHQUFHLEtBQUs7SUFDUixPQUFPLFlBQVk7UUFDakIsT0FBTyxFQUFFLE1BQU0sQ0FBQztZQUFFLEtBQUs7WUFBRyxLQUFLO1FBQUk7UUFDbkMsTUFBTSxFQUFFLE9BQU87SUFDakIsR0FDRyxLQUFLLEdBQ0wsS0FBSyxDQUFDLFdBQVc7UUFBQztLQUFPO0FBQzlCLEdBQUc7QUFLSCxNQUFNLGdCQUFnQixFQUFFLE1BQU0sQ0FDNUIsRUFBRSxNQUFNLENBQUM7SUFBRSxLQUFLO0FBQUksSUFDcEIsQ0FBQyxRQUFVLE1BQU0sSUFBSSxHQUFHLE1BQU0sR0FBRyxHQUNqQztBQUVGLE1BQU0sc0JBQXNCLEVBQUUsTUFBTSxDQUNsQyxFQUFFLE1BQU0sQ0FBQztJQUFFLEtBQUs7QUFBSSxJQUNwQixDQUFDLFFBQVUsTUFBTSxJQUFJLEdBQUcsTUFBTSxHQUFHLEdBQ2pDO0FBRUYsTUFBTSxrQkFBa0IsRUFBRSxNQUFNLENBQUM7SUFBRSxTQUFTO0lBQU0sS0FBSztBQUFFO0FBRXpELE9BQU8sTUFBTSxVQUFVLGNBQWM7SUFDbkMsUUFBUTtJQUNSO0FBQ0YsR0FBRyxTQUFTLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsR0FBSyxDQUFDO1FBQ3JDLFNBQVM7WUFDUCxLQUFLLE1BQU07Z0JBQ1QsYUFBYTtnQkFDYixNQUFNLENBQUM7Z0JBQ1AsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEdBQUssR0FBRyxLQUFLLENBQUMsWUFDM0IsS0FBSyxHQUNMLE9BQU8sQ0FBQyxpQkFBaUIsT0FDekIsS0FBSztZQUNWO1lBRUEsUUFBUSxTQUFTO2dCQUNmLGFBQWE7Z0JBQ2IsTUFBTTtvQkFDSixhQUFhO29CQUNiLFNBQVMsRUFBRSxRQUFRLENBQUM7Z0JBQ3RCO2dCQUNBLE9BQU87b0JBQUUsYUFBYTtnQkFBTTtnQkFDNUIsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxXQUFXLEVBQUUsT0FBTyxFQUFFO29CQUN4QyxNQUFNLFFBQVEsWUFBWSxJQUFJO29CQUM5QixNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsWUFDdEIsS0FBSyxHQUNMLE9BQU8sQ0FBQyxpQkFBaUIsT0FDekIsS0FBSztvQkFDUixJQUFJLFlBQVksTUFBTTt3QkFDcEIsSUFBSSxTQUFTOzRCQUNYLE1BQU0sSUFBSSxzQkFBc0IsWUFBWSxRQUFRLEdBQUcsRUFBRSxNQUFNLFFBQVEsUUFBUTt3QkFDakY7d0JBQ0EsT0FBTyxHQUFHLEtBQUssQ0FBQyxZQUFZLE1BQU0sQ0FBQzs0QkFBRSxhQUFhO3dCQUFNO29CQUMxRDtvQkFDQSxJQUFJLENBQUMsU0FBUzt3QkFDWixNQUFNLElBQUksc0JBQXNCLFlBQVksV0FBVyxTQUFTO29CQUNsRTtvQkFDQSxPQUFPLEdBQUcsS0FBSyxDQUFDLFlBQVksS0FBSyxDQUMvQixRQUFRLEdBQUcsRUFDWDt3QkFBRSxhQUFhO29CQUFNLEdBQ3JCO3dCQUFFLFdBQVc7b0JBQVE7Z0JBRXpCO1lBQ0Y7UUFDRjtRQUVBLE9BQU87WUFDTCxNQUFNLE1BQU07Z0JBQ1YsYUFBYTtnQkFDYixNQUFNLENBQUM7Z0JBQ1AsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEdBQUssR0FBRyxLQUFLLENBQUMsU0FDM0IsS0FBSyxHQUNMLE9BQU8sQ0FBQyxpQkFBaUIsT0FDekIsT0FBTztZQUNaO1lBRUEsS0FBSyxTQUFTO2dCQUNaLGFBQWE7Z0JBQ2IsTUFBTTtvQkFBRSxPQUFPO2dCQUFjO2dCQUM3QixPQUFPO29CQUFFLGFBQWE7Z0JBQU07Z0JBQzVCLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLEdBQUssR0FBRyxLQUFLLENBQUMsU0FBUyxNQUFNLENBQUM7d0JBQ3ZELE9BQU8sTUFBTSxJQUFJO3dCQUNqQixNQUFNO29CQUNSO1lBQ0Y7WUFFQSxTQUFTLFNBQVM7Z0JBQ2hCLGFBQWE7Z0JBQ2IsTUFBTTtvQkFDSixJQUFJLEVBQUUsRUFBRSxDQUFDO29CQUNULE1BQU0sRUFBRSxPQUFPO29CQUNmLFNBQVM7Z0JBQ1g7Z0JBQ0EsT0FBTztvQkFBRSxhQUFhO29CQUFPLFlBQVk7Z0JBQUs7Z0JBQzlDLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsR0FBSyxHQUFHLEtBQUssQ0FBQyxTQUFTLEtBQUssQ0FDakUsSUFDQTt3QkFBRTtvQkFBSyxHQUNQO3dCQUFFLFdBQVc7b0JBQVE7WUFFekI7WUFFQSxRQUFRLFNBQVM7Z0JBQ2YsYUFBYTtnQkFDYixNQUFNO29CQUNKLElBQUksRUFBRSxFQUFFLENBQUM7b0JBQ1QsT0FBTztvQkFDUCxTQUFTO2dCQUNYO2dCQUNBLE9BQU87b0JBQUUsYUFBYTtnQkFBTTtnQkFDNUIsU0FBUyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxHQUFLLEdBQUcsS0FBSyxDQUFDLFNBQVMsS0FBSyxDQUNsRSxJQUNBO3dCQUFFLE9BQU8sTUFBTSxJQUFJO29CQUFHLEdBQ3RCO3dCQUFFLFdBQVc7b0JBQVE7WUFFekI7WUFFQSxRQUFRLFNBQVM7Z0JBQ2YsYUFBYTtnQkFDYixNQUFNO29CQUNKLElBQUksRUFBRSxFQUFFLENBQUM7b0JBQ1QsU0FBUztnQkFDWDtnQkFDQSxPQUFPO29CQUFFLGFBQWE7Z0JBQUs7Z0JBQzNCLFNBQVMsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLE9BQU8sRUFBRSxHQUFLLEdBQUcsS0FBSyxDQUFDLFNBQVMsTUFBTSxDQUM1RCxJQUNBO3dCQUFFLFdBQVc7b0JBQVE7WUFFekI7WUFFQSxnQkFBZ0IsU0FBUztnQkFDdkIsYUFBYTtnQkFDYixNQUFNLENBQUM7Z0JBQ1AsT0FBTztvQkFBRSxhQUFhO2dCQUFLO2dCQUMzQixTQUFTLENBQUMsRUFBRSxFQUFFLEVBQUU7b0JBQ2QsTUFBTSxZQUFZLEdBQUcsS0FBSyxDQUFDLFNBQVMsS0FBSyxHQUFHLEtBQUssQ0FBQyxRQUFRLE1BQU0sT0FBTztvQkFDdkUsS0FBSyxNQUFNLFFBQVEsVUFBVzt3QkFDNUIsR0FBRyxLQUFLLENBQUMsU0FBUyxNQUFNLENBQUMsS0FBSyxHQUFHLEVBQUU7NEJBQUUsV0FBVyxLQUFLLFFBQVE7d0JBQUM7b0JBQ2hFO29CQUNBLE9BQU8sVUFBVSxNQUFNO2dCQUN6QjtZQUNGO1FBQ0Y7SUFDRixDQUFDLEdBQUcifQ==